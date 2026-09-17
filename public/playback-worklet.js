// Плеер с буфером: копит ~250 мс звука перед стартом, поэтому сетевые задержки
// не превращаются в заикание. Пока запаса нет — выдаёт тишину, а не рвёт фразу.

class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.cur = null;
    this.pos = 0;
    this.buffered = 0;
    this.playing = false;
    this.MIN_START = 6000;   // 250 мс при 24 кГц — запас перед началом
    this.port.onmessage = (e) => {
      if (e.data.reset) {
        this.queue = []; this.cur = null; this.pos = 0; this.buffered = 0; this.playing = false;
        return;
      }
      if (e.data.pcm) {
        const f = new Float32Array(e.data.pcm);
        this.queue.push(f);
        this.buffered += f.length;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;

    // ждём, пока накопится запас
    if (!this.playing) {
      if (this.buffered < this.MIN_START) { out.fill(0); return true; }
      this.playing = true;
    }

    let i = 0;
    while (i < out.length) {
      if (!this.cur) {
        this.cur = this.queue.shift() || null;
        this.pos = 0;
        if (!this.cur) {
          // запас кончился — доигрываем тишиной и снова копим
          out.fill(0, i);
          this.playing = false;
          return true;
        }
      }
      const take = Math.min(out.length - i, this.cur.length - this.pos);
      out.set(this.cur.subarray(this.pos, this.pos + take), i);
      i += take;
      this.pos += take;
      this.buffered -= take;
      if (this.pos >= this.cur.length) this.cur = null;
    }
    return true;
  }
}

registerProcessor('playback-processor', PlaybackProcessor);
