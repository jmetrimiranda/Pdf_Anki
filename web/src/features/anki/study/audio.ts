// Card audio in the HOST (spec 8.4; port of qt/aqt/sound.py's AVPlayer): sounds play here rather than inside the
// sandboxed card frame, so they work without a gesture in the frame and never need the frame's network access.
// `play(tags)` interrupts what is playing and plays the tags in order; TTS goes through speechSynthesis.
import type { AvTag } from '../../../lib/core/types';

/** Extensions Anki hands to its video player (mpv); shown in an overlay <video> here. */
const VIDEO_EXT = /\.(mp4|webm|mkv|ogv|mov|m4v|avi|mpe?g|flv|3gp)$/i;

export function isVideo(file: string): boolean {
  return VIDEO_EXT.test(file);
}

/** Anki's TTS language (`en_US`) → BCP 47 (`en-US`). */
export function ttsLang(lang: string): string {
  return lang.trim().replace(/_/g, '-');
}

/** The part of HTMLMediaElement the player uses (one element shared by every sound). */
export interface MediaLike {
  src: string;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: 'ended' | 'error', cb: () => void): void;
  removeEventListener(type: 'ended' | 'error', cb: () => void): void;
}

export interface UtteranceLike {
  lang: string;
  rate: number;
  voice: unknown;
  onend: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface SpeechLike {
  speak(u: UtteranceLike): void;
  cancel(): void;
  getVoices(): { name: string; lang: string }[];
}

export interface PlayerDeps {
  /** URL of a collection media file (`core.cardMediaUrl`). */
  mediaUrl(file: string): string;
  /** The shared audio element (created on first use). */
  audio(): MediaLike;
  /** Plays a video in the overlay; resolves when it ends, is closed or fails. */
  video?(src: string): Promise<void>;
  /** Stops the overlay video, if any. */
  stopVideo?(): void;
  speech(): SpeechLike | null;
  utterance(text: string): UtteranceLike | null;
  /** speechSynthesis is missing: called once per player. */
  onTtsUnavailable(): void;
  onError?(what: string): void;
}

export class AvPlayer {
  private generation = 0;
  private cancelCurrent: (() => void) | null = null;
  private ttsWarned = false;

  constructor(private readonly deps: PlayerDeps) {}

  /** AVPlayer.play_tags: interrupt, then play `tags` in order. */
  play(tags: AvTag[]): void {
    this.stop();
    const gen = this.generation;
    void this.run(tags, gen);
  }

  /** Stops the sound, the speech and the video now. */
  stop(): void {
    this.generation++;
    const cancel = this.cancelCurrent;
    this.cancelCurrent = null;
    cancel?.();
  }

  private async run(tags: AvTag[], gen: number): Promise<void> {
    for (const tag of tags) {
      if (gen !== this.generation) return;
      try {
        await this.playOne(tag);
      } catch {
        this.deps.onError?.(tag.kind === 'sound' ? tag.file : tag.text);
      }
    }
  }

  private playOne(tag: AvTag): Promise<void> {
    if (tag.kind === 'sound') {
      if (!tag.file) return Promise.resolve();
      const src = this.deps.mediaUrl(tag.file);
      if (isVideo(tag.file) && this.deps.video) {
        this.cancelCurrent = () => this.deps.stopVideo?.();
        return this.deps.video(src);
      }
      return this.playSound(src);
    }
    return this.speak(tag);
  }

  private playSound(src: string): Promise<void> {
    const el = this.deps.audio();
    return new Promise<void>((resolve, reject) => {
      const done = () => {
        el.removeEventListener('ended', done);
        el.removeEventListener('error', failed);
        resolve();
      };
      const failed = () => {
        el.removeEventListener('ended', done);
        el.removeEventListener('error', failed);
        reject(new Error(`audio: ${src}`));
      };
      this.cancelCurrent = () => {
        el.pause();
        done();
      };
      el.addEventListener('ended', done);
      el.addEventListener('error', failed);
      el.src = src;
      el.play().catch((e: unknown) => {
        // A pause() of an interrupted sound rejects play(): that is not an error.
        if (e instanceof DOMException && e.name === 'AbortError') done();
        else failed();
      });
    });
  }

  private speak(tag: Extract<AvTag, { kind: 'tts' }>): Promise<void> {
    const speech = this.deps.speech();
    const u = speech ? this.deps.utterance(tag.text) : null;
    if (!speech || !u) {
      if (!this.ttsWarned) {
        this.ttsWarned = true;
        this.deps.onTtsUnavailable();
      }
      return Promise.resolve();
    }
    u.lang = ttsLang(tag.lang);
    u.rate = Number.isFinite(tag.speed) && tag.speed > 0 ? tag.speed : 1;
    const voices = speech.getVoices();
    const voice = tag.voices.map((name) => voices.find((v) => v.name === name)).find(Boolean);
    if (voice) u.voice = voice;
    return new Promise<void>((resolve) => {
      u.onend = () => resolve();
      u.onerror = () => resolve();
      this.cancelCurrent = () => {
        speech.cancel();
        resolve();
      };
      speech.speak(u);
    });
  }
}

/** The tags `R` replays (reviewer.py replay_audio): the question's, or the answer's with the question's first. */
export function replayTags(
  side: 'question' | 'answer',
  question: AvTag[],
  answer: AvTag[],
  replayQuestionOnAnswer: boolean,
): AvTag[] {
  if (side === 'question') return question;
  return replayQuestionOnAnswer ? [...question, ...answer] : answer;
}

/** Browser implementation of the player's dependencies. */
export function browserPlayerDeps(
  over: Partial<PlayerDeps> & Pick<PlayerDeps, 'mediaUrl' | 'onTtsUnavailable'>,
): PlayerDeps {
  let audio: HTMLAudioElement | null = null;
  return {
    audio: () => (audio ??= new Audio()),
    speech: () => (typeof speechSynthesis !== 'undefined' ? (speechSynthesis as unknown as SpeechLike) : null),
    utterance: (text) =>
      typeof SpeechSynthesisUtterance !== 'undefined'
        ? (new SpeechSynthesisUtterance(text) as unknown as UtteranceLike)
        : null,
    ...over,
  };
}
