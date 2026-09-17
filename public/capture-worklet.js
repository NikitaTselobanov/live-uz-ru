// Собирает входящий звук в куски по 100 мс и отдаёт 16-битный PCM.
// AudioContext создаётся с sampleRate: 16000, поэтому ресемплинг делает сам браузер.

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = 1600; // 100 мс при 16 кГц
    this.buf = new Float32Array(this.chunk);
    this.filled = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    // Если каналов несколько — сводим в моно.
    const len = input[0].length;
    const mono = new Float32Array(len);
    for (let ch = 0; ch < input.length; ch++) {
      const data = input[ch];
      for (let i = 0; i < len; i++) mono[i] += data[i] / input.length;
    }

    let offset = 0;
    while (offset < len) {
      const take = Math.min(this.chunk - this.filled, len - offset);
      this.buf.set(mono.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;

      if (this.filled === this.chunk) {
        const pcm = new Int16Array(this.chunk);
        let peak = 0;
        for (let i = 0; i < this.chunk; i++) {
          const s = Math.max(-1, Math.min(1, this.buf[i]));
          pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
          const a = Math.abs(s);
          if (a > peak) peak = a;
        }
        this.port.postMessage({ pcm: pcm.buffer, peak }, [pcm.buffer]);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
