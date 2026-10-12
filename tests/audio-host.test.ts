import { afterEach, describe, expect, test } from "bun:test";
import { AUDIO_RING_FRAMES, type AudioOps } from "@pocketjs/framework/audio";
import { audioFramesForTick } from "../vendor/pocketjs/contracts/spec/audio.ts";
import { createSimAudioSink } from "../vendor/pocketjs/hosts/sim/audio.ts";
import { AudioDriver, createAudioEffects, type AudioDriverState } from "../src/ui/audio/index.ts";
import { QoaFile, type QoaStream } from "../src/ui/audio/qoa.ts";
import { encodeQoa } from "../tools/lib/qoa.ts";

interface MockStream {
  readonly rate: number;
  readonly channels: number;
  free: number;
}

class MockAudioOps implements AudioOps {
  nextHandle = 1;
  readonly streams = new Map<number, MockStream>();
  readonly created: Array<{ handle: number; rate: number; channels: number }> = [];
  readonly destroyed: number[] = [];
  readonly writes: Array<{ handle: number; frames: number; samples: number[] }> = [];
  readonly plays: number[] = [];
  readonly pauses: number[] = [];
  readonly stops: number[] = [];
  readonly volumes: Array<{ handle: number; volume: number }> = [];
  readonly ended: number[] = [];
  readonly events: string[] = [];
  polls = 0;

  createStream(rate: number, channels: number): number {
    const handle = this.nextHandle++;
    this.streams.set(handle, { rate, channels, free: AUDIO_RING_FRAMES });
    this.created.push({ handle, rate, channels });
    return handle;
  }

  destroyStream(handle: number): void {
    this.streams.delete(handle);
    this.destroyed.push(handle);
  }

  writePcm(handle: number, buffer: ArrayBuffer): number {
    const stream = this.streams.get(handle);
    if (!stream) return 0;
    const input = new Int16Array(buffer);
    const frames = Math.min(stream.free, Math.floor(input.length / stream.channels));
    this.writes.push({
      handle,
      frames,
      samples: Array.from(input.slice(0, frames * stream.channels)),
    });
    stream.free -= frames;
    return frames;
  }

  play(handle: number): void { this.plays.push(handle); }
  pause(handle: number): void { this.pauses.push(handle); }
  stop(handle: number): void { this.stops.push(handle); }
  setVolume(handle: number, volume: number): void { this.volumes.push({ handle, volume }); }
  endStream(handle: number): void { this.ended.push(handle); }

  poll(): string | undefined {
    this.polls++;
    return this.events.shift();
  }

  /** Report that the native clock consumed `frames` since the previous sync. */
  credit(handle: number, frames: number): void {
    const stream = this.streams.get(handle)!;
    stream.free = Math.min(AUDIO_RING_FRAMES, stream.free + frames);
    this.events.push(JSON.stringify({ t: "credit", h: handle, free: stream.free }));
  }
}

function wav(samples: readonly number[], sampleRate = 11_025, channels = 1): Uint8Array {
  const dataBytes = samples.length * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  samples.forEach((sample, index) => view.setInt16(44 + index * 2, sample, true));
  return bytes;
}

function qoaSamples(frames: number): Int16Array {
  const samples = new Int16Array(frames);
  for (let index = 0; index < frames; index++) {
    samples[index] = ((index * 977 + 313) % 20_001) - 10_000;
  }
  return samples;
}

function decodedQoa(bytes: Uint8Array): number[] {
  const file = new QoaFile(bytes);
  const stream = file.stream();
  const samples: number[] = [];
  for (let index = 0; index < file.frames; index++) samples.push(stream.sample(index, 0));
  return samples;
}

function frame(
  value: number,
  audio?: AudioDriverState["interp"]["audio"],
  cues: AudioDriverState["interp"]["cues"] = [],
): AudioDriverState {
  return { frame: value, interp: { audio, cues } };
}

const originalAudio = (globalThis as { audio?: unknown }).audio;
afterEach(() => {
  (globalThis as { audio?: unknown }).audio = originalAudio;
});

describe("opt-in audio host", () => {
  test("missing host and missing resources are silent", () => {
    (globalThis as { audio?: unknown }).audio = undefined;
    const Effects = createAudioEffects({});
    expect(Effects({ state: () => frame(0) as never })).toBeNull();

    const ops = new MockAudioOps();
    let reads = 0;
    const driver = new AudioDriver(ops, { known: "audio:wav.missing" }, () => {
      reads++;
      throw new Error("not packed");
    });
    expect(() => driver.sync(frame(1, {
      bgm: { id: "known", volume: 100, pitch: 100, positionTicks: 0 },
    }, [{ name: "unknown", volume: 100, pitch: 100 }]))).not.toThrow();
    driver.sync(frame(2, {
      bgm: { id: "known", volume: 100, pitch: 100, positionTicks: 1 },
    }));
    expect(reads).toBe(1);
    expect(ops.created).toEqual([]);
  });

  test("uses full pak keys, seeks, resamples by deterministic source index, and fills all credit", () => {
    const ops = new MockAudioOps();
    const reads: string[] = [];
    const driver = new AudioDriver(
      ops,
      { field: "audio:wav.music/field" },
      (key) => {
        reads.push(key);
        return wav([10, 20, 30, 40]);
      },
    );
    driver.sync(frame(7, {
      bgm: { id: "field", volume: 75, pitch: 50, positionTicks: 1 },
    }));

    expect(reads).toEqual(["audio:wav.music/field"]);
    expect(ops.created).toEqual([{ handle: 1, rate: 11_025, channels: 1 }]);
    expect(ops.writes).toHaveLength(1);
    expect(ops.writes[0]!.frames).toBe(AUDIO_RING_FRAMES);
    // tick 1 seeks to output frame 183; at 50% pitch the first source frame is
    // floor(183 * .5) % 4 = 3, followed by the nearest-neighbour repeat.
    expect(ops.writes[0]!.samples.slice(0, 6)).toEqual([40, 10, 10, 20, 20, 30]);
    expect(ops.volumes).toEqual([{ handle: 1, volume: 0.75 }]);
    expect(ops.plays).toEqual([1]);
  });

  test("renders centred and panned WAV/QOA PCM with deterministic equal-power samples", () => {
    const wavSource = wav([1000, -2000, 3000, -4000]);
    const qoaSource = encodeQoa(qoaSamples(41), 1, 11_025);
    const fixtures = [
      { key: "audio:wav.tone", bytes: wavSource, decoded: [1000, -2000, 3000, -4000] },
      { key: "audio:qoa.tone", bytes: qoaSource, decoded: decodedQoa(qoaSource) },
    ];

    for (const fixture of fixtures) {
      for (const [pan, channels, expected] of [
        [0, 1, fixture.decoded.slice(0, 4)],
        [-100, 2, fixture.decoded.slice(0, 2).flatMap((sample) => [sample, 0])],
        [100, 2, fixture.decoded.slice(0, 2).flatMap((sample) => [0, sample])],
      ] as const) {
        const ops = new MockAudioOps();
        const driver = new AudioDriver(ops, { tone: fixture.key }, () => fixture.bytes);
        driver.sync(frame(1, {
          bgm: { id: "tone", volume: 100, pitch: 100, pan, positionTicks: 0 },
        }));
        expect(ops.created[0]?.channels, `${fixture.key} pan ${pan}`).toBe(channels);
        expect(ops.writes[0]!.samples.slice(0, expected.length), `${fixture.key} pan ${pan}`).toEqual(expected);
      }
    }

    const ops = new MockAudioOps();
    const driver = new AudioDriver(ops, { tone: "audio:wav.tone" }, () => wavSource);
    driver.sync(frame(1, {
      bgm: { id: "tone", volume: 100, pitch: 100, pan: 50, positionTicks: 0 },
    }));
    expect(ops.writes[0]!.samples.slice(0, 4)).toEqual([383, 924, -765, -1848]);

    const stereoSource = wav([1000, 2000, -3000, 4000], 11_025, 2);
    for (const [pan, expected] of [
      [-100, [3000, 0, 1000, 0]],
      [100, [0, 3000, 0, 1000]],
    ] as const) {
      const stereoOps = new MockAudioOps();
      const stereoDriver = new AudioDriver(
        stereoOps,
        { stereo: "audio:wav.stereo" },
        () => stereoSource,
      );
      stereoDriver.sync(frame(1, {
        bgm: { id: "stereo", volume: 100, pitch: 100, pan, positionTicks: 0 },
      }));
      expect(stereoOps.created[0]?.channels).toBe(2);
      expect(stereoOps.writes[0]!.samples.slice(0, 4), `stereo pan ${pan}`).toEqual([...expected]);
    }
  });

  test("retries a staged QOA miss without rebuilding the driver", () => {
    const ops = new MockAudioOps();
    const key = "audio:qoa.music/field.qoa";
    const bytes = encodeQoa(qoaSamples(AUDIO_RING_FRAMES + 100), 1, 11_025);
    let ready = false;
    let reads = 0;
    const driver = new AudioDriver(ops, { field: key }, () => {
      reads++;
      if (!ready) throw new Error("not staged");
      return bytes;
    });

    driver.sync(frame(1, {
      bgm: { id: "field", volume: 100, pitch: 100, positionTicks: 0 },
    }));
    expect(ops.created).toEqual([]);
    ready = true;
    driver.retryResource(key);
    driver.sync(frame(2, {
      bgm: { id: "field", volume: 100, pitch: 100, positionTicks: 1 },
    }));

    expect(reads).toBe(2);
    expect(ops.created).toHaveLength(1);
    expect(ops.plays).toEqual([1]);
  });

  test("keeps BGM/BGS/ME ahead of deterministic oldest-SE eviction", () => {
    const ops = new MockAudioOps();
    const resources = Object.fromEntries(
      ["bgm", "bgs", "me", "a", "b", "c"].map((id) => [id, `audio:wav.${id}`]),
    );
    const driver = new AudioDriver(ops, resources, () => wav([1, 2, 3, 4]));
    driver.sync(frame(1, {
      bgm: { id: "bgm", volume: 100, pitch: 100, positionTicks: 0 },
      bgs: { id: "bgs", volume: 100, pitch: 100, positionTicks: 0 },
      me: {
        id: "me", volume: 100, pitch: 100, positionTicks: 0,
        durationTicks: 60, leftTicks: 60,
      },
    }, [
      { name: "a", volume: 100, pitch: 100 },
      { name: "b", volume: 100, pitch: 100 },
      { name: "c", volume: 100, pitch: 100 },
    ]));

    expect(ops.created).toHaveLength(6);
    expect(ops.streams.size).toBe(4);
    expect(ops.destroyed).toEqual([4, 5]);
    expect([...ops.streams.keys()]).toEqual([1, 2, 3, 6]);
    expect(ops.pauses).toEqual([]); // BGM was never opened while ME owns it.
    expect(ops.plays).toEqual([2, 3, 6]);
    // Evicted SE are destroyed before the common pump; the surviving SE and
    // ME are one-shots, while BGM/BGS never receive endStream.
    expect(ops.ended).toEqual([3, 6]);
  });

  test("a stop cue destroys every live SE voice but leaves BGM/BGS/ME playing", () => {
    const ops = new MockAudioOps();
    const resources = Object.fromEntries(
      ["bgm", "a", "b"].map((id) => [id, `audio:wav.${id}`]),
    );
    const driver = new AudioDriver(ops, resources, () => wav([1, 2, 3, 4]));
    driver.sync(frame(1, {
      bgm: { id: "bgm", volume: 100, pitch: 100, positionTicks: 0 },
    }, [
      { name: "a", volume: 100, pitch: 100 },
      { name: "b", volume: 100, pitch: 100 },
    ]));
    expect(ops.created).toHaveLength(3); // bgm + two SE
    expect(ops.streams.size).toBe(3);

    // Stop SE: both SE voices are destroyed; the BGM voice survives.
    driver.sync(frame(2, {
      bgm: { id: "bgm", volume: 100, pitch: 100, positionTicks: 1 },
    }, [{ stop: true }]));
    expect(ops.destroyed).toEqual([2, 3]);
    expect(ops.streams.has(1)).toBe(true);
    expect(ops.streams.size).toBe(1);

    // A later SE plays on a fresh voice; the stop was one-shot.
    driver.sync(frame(3, {
      bgm: { id: "bgm", volume: 100, pitch: 100, positionTicks: 2 },
    }, [{ name: "a", volume: 100, pitch: 100 }]));
    expect(ops.streams.has(4)).toBe(true);
  });

  test("applies reducer fade volume monotonically while refilling credits", () => {
    const ops = new MockAudioOps();
    const driver = new AudioDriver(ops, { field: "audio:wav.field" }, () => wav([1, 2, 3, 4]));
    const positionFrames = (ticks: number): number => Math.floor(ticks * 11_025 / 60);

    for (let tick = 0; tick < 4; tick++) {
      if (tick > 0) ops.credit(1, positionFrames(tick) - positionFrames(tick - 1));
      driver.sync(frame(tick + 1, {
        bgm: {
          id: "field",
          volume: 80,
          pitch: 100,
          positionTicks: tick,
          fade: { totalTicks: 4, leftTicks: 4 - tick },
        },
      }));
    }

    expect(ops.created).toHaveLength(1);
    expect(ops.volumes.map(({ volume }) => volume)).toEqual([0.8, 0.6, 0.4, 0.2]);
    expect(ops.writes.slice(1).map(({ frames }) => frames).reduce((a, b) => a + b, 0))
      .toBe(positionFrames(3));
  });

  test("same frame does not replay SE; rewind rebuilds tracks and suppresses historical cues", () => {
    const ops = new MockAudioOps();
    const resources = { field: "audio:wav.field", click: "audio:wav.click" };
    const driver = new AudioDriver(ops, resources, () => wav([5, 6, 7, 8]));
    const state = frame(10, {
      bgm: { id: "field", volume: 100, pitch: 100, positionTicks: 9 },
    }, [{ name: "click", volume: 100, pitch: 100 }]);
    driver.sync(state);
    driver.sync(state);
    expect(ops.created).toHaveLength(2);

    driver.sync(frame(7, {
      bgm: { id: "field", volume: 100, pitch: 100, positionTicks: 6 },
    }, [{ name: "click", volume: 100, pitch: 100 }]));

    expect(ops.destroyed).toEqual([1, 2]);
    expect(ops.created).toHaveLength(3); // rebuilt BGM only; rewind cue was suppressed.
    expect(ops.streams.size).toBe(1);
  });

  test("same-timeline presentation gain updates keep streams and PCM position", () => {
    const ops = new MockAudioOps();
    const music = Array.from({ length: AUDIO_RING_FRAMES + 64 }, (_, index) => index + 1);
    const resources = { field: "audio:wav.field", click: "audio:wav.click" };
    const driver = new AudioDriver(ops, resources, (key) =>
      key === resources.field ? wav(music) : wav([7, 8, 9]));
    const timeline = frame(10, {
      bgm: { id: "field", volume: 80, pitch: 100, positionTicks: 0 },
    }, [{ name: "click", volume: 50, pitch: 100 }]);
    const projected = (musicVolume: number, soundVolume: number) => frame(10, {
      bgm: { id: "field", volume: musicVolume, pitch: 100, positionTicks: 0 },
    }, [{ name: "click", volume: soundVolume, pitch: 100 }]);

    driver.sync(projected(40, 10), timeline);
    expect(ops.created.map(({ handle }) => handle)).toEqual([1, 2]);
    expect(ops.plays).toEqual([1, 2]);
    expect(ops.writes.find(({ handle }) => handle === 1)?.frames).toBe(AUDIO_RING_FRAMES);

    ops.credit(1, 32);
    driver.sync(projected(72, 20), timeline);

    expect(ops.created.map(({ handle }) => handle)).toEqual([1, 2]);
    expect(ops.destroyed).toEqual([]);
    expect(ops.plays).toEqual([1, 2]);
    expect(ops.volumes).toContainEqual({ handle: 1, volume: 0.72 });
    const musicWrites = ops.writes.filter(({ handle }) => handle === 1);
    expect(musicWrites).toHaveLength(2);
    expect(musicWrites[1]!.samples).toEqual(music.slice(AUDIO_RING_FRAMES, AUDIO_RING_FRAMES + 32));

    // A genuinely different reducer object at the same frame remains a
    // refold: rebuild persistent audio and suppress its historical cue.
    const restoredTimeline = structuredClone(timeline);
    driver.sync(projected(72, 20), restoredTimeline);
    expect(ops.destroyed).toEqual([1, 2]);
    expect(ops.created.map(({ handle }) => handle)).toEqual([1, 2, 3]);
  });

  test("the virtual-clock host consumes the exact PCM budget and sees a monotonic fade", () => {
    const sink = createSimAudioSink();
    const driver = new AudioDriver(
      sink.ns as unknown as AudioOps,
      { tone: "audio:wav.tone" },
      () => wav([100, -100, 200, -200], 11_025),
    );
    const ticks = 60;
    for (let tick = 0; tick < ticks; tick++) {
      driver.sync(frame(tick + 1, {
        bgm: {
          id: "tone",
          volume: 80,
          pitch: 100,
          positionTicks: tick,
          fade: { totalTicks: ticks, leftTicks: ticks - tick },
        },
      }));
      sink.tick();
    }

    const expected = Array.from({ length: ticks }, (_, tick) => audioFramesForTick(11_025, tick))
      .reduce((sum, frames) => sum + frames, 0);
    expect(sink.consumedFrames()).toBe(expected);
    expect(expected).toBe(11_025);
    expect(sink.log.some((line) => line.includes('"underrun"'))).toBe(false);
    const volumes = sink.log
      .filter((line) => line.startsWith("op setVolume "))
      .map((line) => Number(line.split(" ")[3]));
    expect(volumes).toHaveLength(ticks);
    expect(volumes.every((value, index) => index === 0 || value < volumes[index - 1]!)).toBe(true);
  });

  test("streams QOA through the virtual-clock host with an exact per-tick budget and monotonic fade", () => {
    const sink = createSimAudioSink();
    const samples = qoaSamples(257);
    const driver = new AudioDriver(
      sink.ns as unknown as AudioOps,
      { tone: "audio:qoa.tone" },
      () => encodeQoa(samples, 1, 11_025),
    );
    const ticks = 60;

    for (let tick = 0; tick < ticks; tick++) {
      driver.sync(frame(tick + 1, {
        bgm: {
          id: "tone",
          volume: 80,
          pitch: 100,
          positionTicks: tick,
          fade: { totalTicks: ticks, leftTicks: ticks - tick },
        },
      }));
      const before = sink.consumedFrames();
      sink.tick();
      expect(sink.consumedFrames() - before).toBe(audioFramesForTick(11_025, tick));
    }

    expect(sink.consumedFrames()).toBe(11_025);
    expect(sink.log.some((line) => line.includes('"underrun"'))).toBe(false);
    const volumes = sink.log
      .filter((line) => line.startsWith("op setVolume "))
      .map((line) => Number(line.split(" ")[3]));
    expect(volumes).toHaveLength(ticks);
    expect(volumes.every((value, index) => index === 0 || value < volumes[index - 1]!)).toBe(true);
  });

  test("keeps one QOA voice while real-time host credit arrives in coarse batches", () => {
    const ops = new MockAudioOps();
    const bytes = encodeQoa(qoaSamples(AUDIO_RING_FRAMES + 2_000), 1, 11_025);
    const driver = new AudioDriver(ops, { field: "audio:qoa.field" }, () => bytes, 15);
    const bgm = (positionTicks: number) => ({
      id: "field",
      volume: 100,
      pitch: 100,
      positionTicks,
    });

    driver.sync(frame(1, { bgm: bgm(0) }));
    // At 4 Hz the reducer advances 15 reference ticks per host frame. The web
    // worklet may report no credit for several such calls; that is clock
    // batching, not a seek.
    driver.sync(frame(2, { bgm: bgm(15) }));
    driver.sync(frame(3, { bgm: bgm(30) }));
    driver.sync(frame(4, { bgm: bgm(45) }));
    expect(ops.created).toHaveLength(1);
    expect(ops.destroyed).toEqual([]);

    ops.credit(1, 512);
    driver.sync(frame(5, { bgm: bgm(60) }));
    expect(ops.created).toHaveLength(1);
    expect(ops.destroyed).toEqual([]);
    expect(ops.writes.map(({ frames }) => frames)).toEqual([AUDIO_RING_FRAMES, 512]);
  });

  test("rebuilds once on a partial fatal batch, then lets its music continue", () => {
    const ops = new MockAudioOps();
    const driver = new AudioDriver(
      ops,
      { field: "audio:qoa.field" },
      () => encodeQoa(qoaSamples(5_000), 1, 11_025),
      15,
    );
    const bgm = (positionTicks: number) => ({
      id: "field",
      volume: 100,
      pitch: 100,
      positionTicks,
    });

    driver.sync(frame(1, { bgm: bgm(0) }));
    driver.sync({
      frame: 2,
      interp: {
        audio: { bgm: bgm(5) },
        cues: [],
        error: { kind: "content", message: "fixture" },
      },
    });
    driver.sync({
      frame: 3,
      interp: {
        audio: { bgm: bgm(6) },
        cues: [],
        error: { kind: "content", message: "fixture" },
      },
    });

    expect(ops.created.map(({ handle }) => handle)).toEqual([1, 2]);
    expect(ops.destroyed).toEqual([1]);
    expect([...ops.streams.keys()]).toEqual([2]);
  });

  test("rejects an invalid reducer-to-host clock ratio", () => {
    const ops = new MockAudioOps();
    expect(() => new AudioDriver(ops, {}, undefined, 0)).toThrow("positive integer");
    expect(() => new AudioDriver(ops, {}, undefined, Number.NaN)).toThrow("positive integer");
  });

  test("rebuilds a persistent voice for a discontinuous reducer seek", () => {
    const ops = new MockAudioOps();
    const driver = new AudioDriver(
      ops,
      { field: "audio:qoa.field" },
      () => encodeQoa(qoaSamples(257), 1, 11_025),
    );

    driver.sync(frame(1, {
      bgm: { id: "field", volume: 100, pitch: 100, positionTicks: 0 },
    }));
    driver.sync(frame(2, {
      bgm: { id: "field", volume: 100, pitch: 100, positionTicks: 100 },
    }));

    expect(ops.created.map(({ handle }) => handle)).toEqual([1, 2]);
    expect(ops.destroyed).toEqual([1]);
    expect([...ops.streams.keys()]).toEqual([2]);
  });

  test("restarts the same active track when its reducer position resets", () => {
    const ops = new MockAudioOps();
    const driver = new AudioDriver(
      ops,
      { field: "audio:qoa.field" },
      () => encodeQoa(qoaSamples(257), 1, 11_025),
    );
    const start = {
      bgm: { id: "field", volume: 100, pitch: 100, positionTicks: 0 },
    };

    driver.sync(frame(1, start));
    // A second playBgm for the same id at the next reducer tick resets the
    // position to zero instead of naturally advancing to one.
    driver.sync(frame(2, start));

    expect(ops.created.map(({ handle }) => handle)).toEqual([1, 2]);
    expect(ops.destroyed).toEqual([1]);
  });

  test("seeks to low-Hz pause, resume, and ME transition positions", () => {
    const ops = new MockAudioOps();
    const bytes = encodeQoa(qoaSamples(5_000), 1, 11_025);
    const driver = new AudioDriver(
      ops,
      { field: "audio:qoa.field", fanfare: "audio:qoa.fanfare" },
      () => bytes,
      15,
    );

    driver.sync(frame(1, {
      bgm: { id: "field", volume: 100, pitch: 100, positionTicks: 0 },
    }));
    // Each host frame spans 15 reducer ticks at 4 Hz. A pause five ticks into
    // the batch leaves the reducer at 5 while the host was still playing the
    // old gate for the batch, so the presentation voice must seek/rebuild.
    driver.sync(frame(2, {
      bgm: { id: "field", volume: 100, pitch: 100, positionTicks: 5, paused: true },
    }));
    driver.sync(frame(3, {
      bgm: { id: "field", volume: 100, pitch: 100, positionTicks: 9 },
    }));
    driver.sync(frame(4, {
      bgm: { id: "field", volume: 100, pitch: 100, positionTicks: 11 },
      me: {
        id: "fanfare", volume: 100, pitch: 100, positionTicks: 12,
        durationTicks: 30, leftTicks: 18,
      },
    }));

    expect(ops.created.map(({ handle }) => handle)).toEqual([1, 2, 3, 4, 5]);
    expect(ops.destroyed).toEqual([1, 2, 3]);
    expect([...ops.streams.keys()]).toEqual([4, 5]);
    expect(ops.plays).toEqual([1, 3, 5]);
  });

  test("replays a same-id ME after its earlier media ended", () => {
    const ops = new MockAudioOps();
    const driver = new AudioDriver(
      ops,
      { fanfare: "audio:qoa.fanfare" },
      () => encodeQoa(qoaSamples(41), 1, 11_025),
    );
    const me = (positionTicks: number) => ({
      id: "fanfare",
      volume: 100,
      pitch: 100,
      positionTicks,
      durationTicks: 120,
      leftTicks: 120 - positionTicks,
    });

    driver.sync(frame(1, { me: me(0) }));
    ops.events.push(JSON.stringify({ t: "ended", h: 1 }));
    driver.sync(frame(2, { me: me(1) }));
    expect(ops.created).toHaveLength(1); // authored duration keeps it silent.
    driver.sync(frame(3, { me: me(0) }));

    expect(ops.created.map(({ handle }) => handle)).toEqual([1, 2]);
    expect(ops.destroyed).toEqual([1]);
    expect(ops.plays).toEqual([1, 2]);
  });

  test("treats a forward frame jump as a load and suppresses historical cues", () => {
    const ops = new MockAudioOps();
    const bytes = encodeQoa(qoaSamples(257), 1, 11_025);
    const driver = new AudioDriver(
      ops,
      { field: "audio:qoa.field", click: "audio:qoa.click" },
      () => bytes,
    );

    driver.sync(frame(1, {
      bgm: { id: "field", volume: 100, pitch: 100, positionTicks: 0 },
    }));
    driver.sync(frame(10, {
      bgm: { id: "field", volume: 100, pitch: 100, positionTicks: 9 },
    }, [{ name: "click", volume: 100, pitch: 100 }]));

    expect(ops.created.map(({ handle }) => handle)).toEqual([1, 2]);
    expect(ops.destroyed).toEqual([1]);
    expect([...ops.streams.keys()]).toEqual([2]);
  });

  test("loops decoded QOA samples without a gap at the source boundary", () => {
    const ops = new MockAudioOps();
    const sourceFrames = 41;
    const bytes = encodeQoa(qoaSamples(sourceFrames), 1, 11_025);
    const decoded = decodedQoa(bytes);
    const driver = new AudioDriver(ops, { tone: "audio:qoa.tone" }, () => bytes);

    driver.sync(frame(1, {
      bgm: { id: "tone", volume: 100, pitch: 100, positionTicks: 0 },
    }));

    expect(ops.writes).toHaveLength(1);
    expect(ops.writes[0]!.frames).toBe(AUDIO_RING_FRAMES);
    expect(ops.writes[0]!.samples.slice(sourceFrames - 2, sourceFrames + 3)).toEqual([
      decoded[sourceFrames - 2],
      decoded[sourceFrames - 1],
      decoded[0],
      decoded[1],
      decoded[2],
    ]);
  });

  test("pauses and resumes a running QOA BGM around both pause state and ME priority", () => {
    const ops = new MockAudioOps();
    const bytes = encodeQoa(qoaSamples(257), 1, 11_025);
    const driver = new AudioDriver(
      ops,
      { field: "audio:qoa.field", fanfare: "audio:qoa.fanfare" },
      () => bytes,
    );
    const positionFrames = (ticks: number): number => Math.floor(ticks * 11_025 / 60);
    const bgm = (positionTicks: number, paused = false) => ({
      id: "field",
      volume: 100,
      pitch: 100,
      positionTicks,
      ...(paused ? { paused: true as const } : {}),
    });

    driver.sync(frame(1, { bgm: bgm(0) }));
    ops.credit(1, positionFrames(1));
    driver.sync(frame(2, { bgm: bgm(1, true) }));
    driver.sync(frame(3, { bgm: bgm(1) }));

    ops.credit(1, positionFrames(2) - positionFrames(1));
    driver.sync(frame(4, {
      bgm: bgm(2),
      me: {
        id: "fanfare",
        volume: 70,
        pitch: 100,
        positionTicks: 0,
        durationTicks: 30,
        leftTicks: 30,
      },
    }));
    driver.sync(frame(5, { bgm: bgm(2) }));

    expect(ops.created.map(({ handle }) => handle)).toEqual([1, 2]);
    expect(ops.pauses).toEqual([1, 1]);
    expect(ops.plays).toEqual([1, 1, 2, 1]);
    expect(ops.destroyed).toEqual([2]);
    expect([...ops.streams.keys()]).toEqual([1]);
  });

  test("restores a scene-replaced BGM from its paused native ring", () => {
    const ops = new MockAudioOps();
    const bytes = encodeQoa(qoaSamples(AUDIO_RING_FRAMES + 1_000), 1, 11_025);
    const driver = new AudioDriver(
      ops,
      {
        map: "audio:qoa.map",
        battle: "audio:qoa.battle",
        victory: "audio:qoa.victory",
      },
      () => bytes,
    );
    const bgm = (id: string, positionTicks: number) => ({
      id,
      volume: 100,
      pitch: 100,
      positionTicks,
    });

    driver.sync(frame(1, { bgm: bgm("map", 7) }));
    const mapWritesBeforeBattle = ops.writes.filter(({ handle }) => handle === 1).length;
    ops.credit(1, audioFramesForTick(11_025, 0));
    driver.sync(frame(2, { bgm: bgm("battle", 0) }));
    expect(ops.writes.filter(({ handle }) => handle === 1)).toHaveLength(mapWritesBeforeBattle);
    driver.sync(frame(3, { bgm: bgm("victory", 0) }));
    const mapWritesBeforeRestore = ops.writes.filter(({ handle }) => handle === 1).length;
    expect(mapWritesBeforeRestore).toBeGreaterThan(mapWritesBeforeBattle);
    // The map stream played for the frame before scene ownership changed,
    // matching the reducer's returnAudio capture at the next reference tick.
    driver.sync(frame(4, { bgm: bgm("map", 8) }));

    expect(ops.created.map(({ handle }) => handle)).toEqual([1, 2, 3]);
    expect(ops.destroyed).toEqual([2, 3]);
    expect(ops.pauses).toEqual([1]);
    expect(ops.plays).toEqual([1, 2, 3, 1]);
    expect([...ops.streams.keys()]).toEqual([1]);
    expect(ops.writes.filter(({ handle }) => handle === 1)).toHaveLength(mapWritesBeforeRestore);
  });

  test("battle SE pressure evicts the oldest transient before the suspended map stream", () => {
    const ops = new MockAudioOps();
    const resources = Object.fromEntries(
      ["map", "battle", "a", "b", "c"].map((id) => [id, `audio:wav.${id}`]),
    );
    const driver = new AudioDriver(ops, resources, () => wav([1, 2, 3, 4]));
    const bgm = (id: string, positionTicks: number) => ({
      id, volume: 100, pitch: 100, positionTicks,
    });

    driver.sync(frame(1, { bgm: bgm("map", 7) }));
    driver.sync(frame(2, { bgm: bgm("battle", 0) }, [
      { name: "a", volume: 100, pitch: 100 },
      { name: "b", volume: 100, pitch: 100 },
      { name: "c", volume: 100, pitch: 100 },
    ]));
    driver.sync(frame(3, { bgm: bgm("map", 8) }, [{ stop: true }]));

    expect(ops.created.map(({ handle }) => handle)).toEqual([1, 2, 3, 4, 5]);
    expect(ops.destroyed).toEqual([3, 2, 4, 5]);
    expect([...ops.streams.keys()]).toEqual([1]);
    expect(ops.plays.filter((handle) => handle === 1)).toEqual([1, 1]);
  });

  test("decodes only the QOA slices needed to fill credited ring space", () => {
    const sourceFrames = AUDIO_RING_FRAMES + 1_000;
    const bytes = encodeQoa(qoaSamples(sourceFrames), 1, 11_025);
    const ops = new MockAudioOps();
    const opened: QoaStream[] = [];
    const originalStream = QoaFile.prototype.stream;
    QoaFile.prototype.stream = function streamWithProbe(): QoaStream {
      const stream = originalStream.call(this);
      opened.push(stream);
      return stream;
    };

    try {
      const driver = new AudioDriver(ops, { field: "audio:qoa.field" }, () => bytes);
      driver.sync(frame(1, {
        bgm: { id: "field", volume: 100, pitch: 100, positionTicks: 0 },
      }));

      expect(opened).toHaveLength(1);
      expect(opened[0]!.decodedFrames).toBe(Math.ceil(AUDIO_RING_FRAMES / 20) * 20);
      expect(opened[0]!.decodedFrames).toBeLessThan(sourceFrames);

      const credited = audioFramesForTick(11_025, 0);
      ops.credit(1, credited);
      driver.sync(frame(2, {
        bgm: { id: "field", volume: 100, pitch: 100, positionTicks: 1 },
      }));
      expect(opened[0]!.decodedFrames).toBe(Math.ceil((AUDIO_RING_FRAMES + credited) / 20) * 20);
      expect(opened[0]!.decodedFrames).toBeLessThan(sourceFrames);
    } finally {
      QoaFile.prototype.stream = originalStream;
    }
  });
});
