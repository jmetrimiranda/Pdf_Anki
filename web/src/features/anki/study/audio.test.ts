import { describe, expect, it, vi } from 'vitest';
import type { AvTag } from '../../../lib/core/types';
import { AvPlayer, isVideo, replayTags, ttsLang, type MediaLike, type PlayerDeps, type UtteranceLike } from './audio';

class FakeAudio implements MediaLike {
  src = '';
  played: string[] = [];
  paused = 0;
  private listeners = new Map<string, Set<() => void>>();
  play() {
    this.played.push(this.src);
    return Promise.resolve();
  }
  pause() {
    this.paused++;
  }
  addEventListener(type: string, cb: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(cb);
  }
  removeEventListener(type: string, cb: () => void) {
    this.listeners.get(type)?.delete(cb);
  }
  fire(type: 'ended' | 'error') {
    for (const cb of [...(this.listeners.get(type) ?? [])]) cb();
  }
}

class FakeUtterance implements UtteranceLike {
  lang = '';
  rate = 1;
  voice: unknown = null;
  onend: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly text: string) {}
}

function setup(withSpeech = true) {
  const audio = new FakeAudio();
  const spoken: FakeUtterance[] = [];
  const speech = {
    speak: vi.fn((u: UtteranceLike) => spoken.push(u as FakeUtterance)),
    cancel: vi.fn(),
    getVoices: () => [
      { name: 'Alex', lang: 'en-US' },
      { name: 'Luciana', lang: 'pt-BR' },
    ],
  };
  const deps: PlayerDeps = {
    mediaUrl: (f) => `/__card/${encodeURIComponent(f)}`,
    audio: () => audio,
    speech: () => (withSpeech ? speech : null),
    utterance: (text) => new FakeUtterance(text),
    onTtsUnavailable: vi.fn(),
  };
  return { player: new AvPlayer(deps), audio, speech, spoken, deps };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const sound = (file: string): AvTag => ({ kind: 'sound', file });

describe('AvPlayer', () => {
  it('plays the tags in order through one shared element', async () => {
    const { player, audio } = setup();
    player.play([sound('a.mp3'), sound('b c.wav')]);
    await flush();
    expect(audio.played).toEqual(['/__card/a.mp3']);
    audio.fire('ended');
    await flush();
    expect(audio.played).toEqual(['/__card/a.mp3', '/__card/b%20c.wav']);
  });

  it('a new play interrupts the current queue (AVPlayer.play_tags)', async () => {
    const { player, audio } = setup();
    player.play([sound('a.mp3'), sound('b.mp3')]);
    await flush();
    player.play([sound('c.mp3')]);
    await flush();
    expect(audio.paused).toBe(1);
    audio.fire('ended');
    await flush();
    expect(audio.played).toEqual(['/__card/a.mp3', '/__card/c.mp3']);
  });

  it('skips empty (unsafe) names and goes on after an error', async () => {
    const { player, audio, deps } = setup();
    deps.onError = vi.fn();
    player.play([sound(''), sound('x.mp3'), sound('y.mp3')]);
    await flush();
    audio.fire('error');
    await flush();
    expect(deps.onError).toHaveBeenCalled();
    expect(audio.played).toEqual(['/__card/x.mp3', '/__card/y.mp3']);
  });

  it('speaks TTS with the language, speed and voice of the tag', async () => {
    const { player, spoken, speech } = setup();
    player.play([{ kind: 'tts', text: 'windmill', lang: 'en_US', voices: ['Nope', 'Alex'], speed: 1.4 }]);
    await flush();
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toMatchObject({ text: 'windmill', lang: 'en-US', rate: 1.4, voice: { name: 'Alex' } });
    player.stop();
    expect(speech.cancel).toHaveBeenCalled();
    player.play([{ kind: 'tts', text: 'casa', lang: 'pt_BR', voices: [], speed: 0 }]);
    await flush();
    expect(spoken[1]).toMatchObject({ lang: 'pt-BR', rate: 1, voice: null });
  });

  it('warns once when speech synthesis is missing', async () => {
    const { player, deps } = setup(false);
    const tts: AvTag = { kind: 'tts', text: 'a', lang: 'en_US', voices: [], speed: 1 };
    player.play([tts]);
    await flush();
    player.play([tts]);
    await flush();
    expect(deps.onTtsUnavailable).toHaveBeenCalledTimes(1);
  });
});

describe('helpers', () => {
  it('maps Anki languages and video names', () => {
    expect(ttsLang('en_US')).toBe('en-US');
    expect(ttsLang('pt_BR')).toBe('pt-BR');
    expect(isVideo('clip.MP4')).toBe(true);
    expect(isVideo('a.mp3')).toBe(false);
  });

  it('replays the question audio first on the answer side when the deck says so', () => {
    const q = [sound('q.mp3')];
    const a = [sound('a.mp3')];
    expect(replayTags('question', q, a, true)).toEqual(q);
    expect(replayTags('answer', q, a, true)).toEqual([...q, ...a]);
    expect(replayTags('answer', q, a, false)).toEqual(a);
  });
});
