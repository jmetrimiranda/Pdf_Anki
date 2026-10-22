//! A render actor: one thread that owns a PdfCraft `RenderPool` (which is `!Sync` and only
//! offers polling) and serves blocking requests from any thread.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender};
use std::time::Duration;

use pdfcraft_render::{RenderConfig, RenderPool, RenderRequest, RenderedPage};

use crate::PdfError;
use crate::error::guard;

/// How often the actor polls the pool while work is outstanding.
const POLL: Duration = Duration::from_millis(3);
/// PdfCraft's watchdog gives up on a page after 20 s; this only guards against a lost reply.
const WAIT: Duration = Duration::from_secs(60);

type Reply = SyncSender<Result<Arc<RenderedPage>, PdfError>>;

enum Msg {
    Render {
        id: u64,
        req: RenderRequest,
        reply: Reply,
    },
    Cancel(u64),
}

struct Pending {
    id: u64,
    req: RenderRequest,
    reply: Reply,
}

pub(crate) struct RenderActor {
    tx: Sender<Msg>,
    next_id: AtomicU64,
}

impl RenderActor {
    /// Spawns the actor thread. It stops (dropping the pool) when the actor is dropped.
    pub(crate) fn spawn(
        bytes: Arc<Vec<u8>>,
        config: RenderConfig,
        threads: usize,
        name: String,
    ) -> Result<Self, PdfError> {
        let (tx, rx) = mpsc::channel();
        std::thread::Builder::new()
            .name(name)
            .spawn(move || run(bytes, config, threads, rx))
            .map_err(|e| PdfError::Internal(format!("spawn render actor: {e}")))?;
        Ok(Self {
            tx,
            next_id: AtomicU64::new(0),
        })
    }

    /// Renders `req`, blocking the calling thread until the pool delivers it.
    pub(crate) fn render(&self, req: RenderRequest) -> Result<Arc<RenderedPage>, PdfError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (reply, rx) = mpsc::sync_channel(1);
        self.tx
            .send(Msg::Render { id, req, reply })
            .map_err(|_| PdfError::Internal("render actor stopped".into()))?;
        match rx.recv_timeout(WAIT) {
            Ok(result) => result,
            Err(RecvTimeoutError::Timeout) => {
                let _ = self.tx.send(Msg::Cancel(id));
                Err(PdfError::Timeout)
            }
            Err(RecvTimeoutError::Disconnected) => {
                Err(PdfError::Internal("render actor stopped".into()))
            }
        }
    }
}

fn run(bytes: Arc<Vec<u8>>, config: RenderConfig, threads: usize, rx: Receiver<Msg>) {
    let pool = match guard(|| Ok(RenderPool::new(bytes, threads, config))) {
        Ok(pool) => pool,
        Err(e) => {
            // Fail every request instead of hanging.
            while let Ok(msg) = rx.recv() {
                if let Msg::Render { reply, .. } = msg {
                    let _ = reply.send(Err(e.clone()));
                }
            }
            return;
        }
    };
    // Newest first: the page the reader just scrolled to is the most urgent.
    let mut pending: Vec<Pending> = Vec::new();
    loop {
        let msg = if pending.is_empty() {
            match rx.recv() {
                Ok(m) => Some(m),
                Err(_) => return,
            }
        } else {
            match rx.recv_timeout(POLL) {
                Ok(m) => Some(m),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        };
        let mut changed = false;
        for m in msg
            .into_iter()
            .chain(std::iter::from_fn(|| rx.try_recv().ok()))
        {
            changed = true;
            match m {
                Msg::Render { id, req, reply } => pending.insert(0, Pending { id, req, reply }),
                Msg::Cancel(id) => pending.retain(|p| p.id != id),
            }
        }
        if changed {
            pool.set_queue(queue(&pending));
        }
        let mut delivered = false;
        while let Some(done) = pool.try_recv() {
            let done = Arc::new(done);
            pending.retain(|p| {
                if p.req != done.request {
                    return true;
                }
                let _ = p.reply.send(Ok(done.clone()));
                false
            });
            delivered = true;
        }
        if delivered {
            pool.set_queue(queue(&pending));
        }
    }
}

/// The pool's wanted work: pending requests, most urgent first, without duplicates.
fn queue(pending: &[Pending]) -> Vec<RenderRequest> {
    let mut out: Vec<RenderRequest> = Vec::with_capacity(pending.len());
    for p in pending {
        if !out.contains(&p.req) {
            out.push(p.req);
        }
    }
    out
}
