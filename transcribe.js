/* ── Audio transcription ──────────────────────────────────────────────
   Turns an audio file into text, entirely on this computer. Ported from the
   VoiceScript project (voice_recording): the audio is decoded in-page (WAV by
   hand so 24/32-bit, float, A-law/µ-law, ADPCM and RF64 files work; everything
   else through the browser), resampled to 16 kHz mono, then run through
   OpenAI's Whisper model with Hugging Face's Transformers.js inside a Web
   Worker so the editor never freezes. The model (~75 MB) downloads from
   huggingface.co the first time and is cached after that.

   Exposes window.FolioTranscribe.transcribeFile(file, onProgress) → Promise<text>.
   onProgress(message, percent) is called as it goes. */
(function () {
  // Decode a recorded audio Blob into mono 16kHz samples (what Whisper expects).
  async function decodeTo16kMono(blob) {
    let arrBuf;
    try { arrBuf = await blob.arrayBuffer(); }
    catch(_) { throw new Error('the file is too large to load in the browser'); }

    // WAV files are decoded by hand: the browser's decoder rejects many
    // common variants (24/32-bit, float, A-law/µ-law, ADPCM, RF64, odd headers).
    let wav = null, wavErr = null;
    try { wav = parseWav(arrBuf); } catch(err) { wavErr = err; console.warn('WAV parser:', err.message); }
    if (wav && wav.samples) return resampleTo16k(wav.samples, wav.rate);

    // Everything else (MP3, M4A, MP3-inside-WAV, …) goes through the browser.
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    let decoded;
    try {
      decoded = await ctx.decodeAudioData(wav && wav.encoded ? wav.encoded : arrBuf);
    } catch(_) {
      throw new Error(wavErr
        ? 'could not read this WAV file (' + wavErr.message + ') — try converting it to MP3 or 16-bit WAV'
        : 'this browser cannot read that audio format — try converting it to MP3 or 16-bit WAV');
    } finally {
      ctx.close();
    }

    const ch = decoded.numberOfChannels;
    const mono = new Float32Array(decoded.length);
    for (let c = 0; c < ch; c++) {
      const d = decoded.getChannelData(c);
      for (let i = 0; i < mono.length; i++) mono[i] += d[i] / ch;
    }
    return resampleTo16k(mono, decoded.sampleRate);
  }

  // Resample mono audio to 16kHz in plain JS (no AudioBuffer size limits, so
  // hour-long files work). Downsampling averages each output window, which
  // doubles as a low-pass filter; upsampling interpolates linearly.
  function resampleTo16k(input, rate) {
    const target = 16000;
    if (!rate || rate === target) return input;
    const ratio = rate / target;
    const out = new Float32Array(Math.floor(input.length / ratio));
    if (ratio > 1) {
      for (let i = 0; i < out.length; i++) {
        const a = Math.floor(i * ratio), b = Math.min(input.length, Math.max(a + 1, Math.floor((i + 1) * ratio)));
        let sum = 0;
        for (let j = a; j < b; j++) sum += input[j];
        out[i] = sum / (b - a);
      }
    } else {
      for (let i = 0; i < out.length; i++) {
        const p = i * ratio, j = Math.floor(p), f = p - j;
        out[i] = input[j] * (1 - f) + (input[j + 1] !== undefined ? input[j + 1] : input[j]) * f;
      }
    }
    return out;
  }

  // Parse a RIFF/WAVE file. Returns null if the data isn't a WAV file,
  // { samples, rate } with mono Float32 samples, or { encoded } when the WAV
  // wraps compressed audio (e.g. MP3) the browser should decode. Throws if
  // it's a WAV encoding we can't handle.
  function parseWav(buf) {
    const v = new DataView(buf);
    const len = v.byteLength;
    const tag = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o+1), v.getUint8(o+2), v.getUint8(o+3));
    if (len < 12 || !/^(RIFF|RIFX|RF64|BW64)$/.test(tag(0)) || tag(8) !== 'WAVE') return null;
    const le = tag(0) !== 'RIFX';  // RIFX = big-endian WAV
    const u16 = (o) => v.getUint16(o, le), u32 = (o) => v.getUint32(o, le);
    const isTag = (o) => { for (let k = 0; k < 4; k++) { const b = v.getUint8(o + k); if (b < 32 || b > 126) return false; } return true; };

    let fmt = null, dataOff = -1, dataLen = 0, off = 12;
    while (off + 8 <= len) {
      if (!isTag(off)) {
        // Some writers forget the pad byte after odd-sized chunks, or the
        // header is damaged — search forward for the next chunk we need.
        let k = Math.max(12, off - 1);
        while (k + 8 <= len && !((tag(k) === 'fmt ' && !fmt) || (tag(k) === 'data' && dataOff < 0))) k++;
        if (k + 8 > len) break;
        off = k;
      }
      const id = tag(off), size = u32(off + 4), body = off + 8;
      if (id === 'fmt ' && !fmt && body + 16 <= len) {
        fmt = {
          format:   u16(body),
          channels: u16(body + 2) || 1,
          rate:     u32(body + 4),
          align:    u16(body + 12),
          bits:     u16(body + 14),
          body, size
        };
        if (fmt.format === 0xFFFE && size >= 26 && body + 26 <= len) fmt.format = u16(body + 24); // WAVE_FORMAT_EXTENSIBLE
      } else if (id === 'data' && dataOff < 0) {
        dataOff = body;
        // Streamed/RF64 files may store 0 or 0xFFFFFFFF here — use what's actually there.
        dataLen = (size === 0 || body + size > len) ? len - body : size;
        if (fmt) break;
      }
      if (body + size > len || size === 0xFFFFFFFF) break;
      off = body + size + (size & 1);
    }
    if (!fmt) throw new Error('missing its format header');
    if (dataOff < 0) throw new Error('missing its audio data');
    if (!fmt.rate) throw new Error('header has no sample rate');

    const ch = fmt.channels;
    const fmtName = { 2: 'MS ADPCM', 0x11: 'IMA ADPCM', 0x31: 'GSM 6.10', 0x50: 'MPEG', 0x55: 'MP3' }[fmt.format]
      || ('format ' + fmt.format + ', ' + fmt.bits + '-bit');

    if (fmt.format === 0x50 || fmt.format === 0x55) return { encoded: buf.slice(dataOff, dataOff + dataLen) };
    if (fmt.format === 0x11) return { samples: decodeImaAdpcm(v, dataOff, dataLen, fmt), rate: fmt.rate };
    if (fmt.format === 2)    return { samples: decodeMsAdpcm(v, dataOff, dataLen, fmt), rate: fmt.rate };

    const bps = Math.floor((fmt.align || Math.ceil(fmt.bits / 8) * ch) / ch) || Math.ceil(fmt.bits / 8); // bytes per sample (container)
    let read;
    if (fmt.format === 1) {        // integer PCM
      if      (bps === 1) read = (o) => (v.getUint8(o) - 128) / 128;
      else if (bps === 2) read = (o) => v.getInt16(o, le) / 32768;
      else if (bps === 3) read = le
        ? (o) => (((v.getUint8(o+2) << 24) | (v.getUint8(o+1) << 16) | (v.getUint8(o) << 8)) >> 8) / 8388608
        : (o) => (((v.getUint8(o) << 24) | (v.getUint8(o+1) << 16) | (v.getUint8(o+2) << 8)) >> 8) / 8388608;
      else if (bps === 4) read = (o) => v.getInt32(o, le) / 2147483648;
    } else if (fmt.format === 3) { // IEEE float
      if      (bps === 4) read = (o) => v.getFloat32(o, le);
      else if (bps === 8) read = (o) => v.getFloat64(o, le);
    } else if (fmt.format === 6 && bps === 1) { // A-law
      read = (o) => alaw(v.getUint8(o)) / 32768;
    } else if (fmt.format === 7 && bps === 1) { // µ-law
      read = (o) => mulaw(v.getUint8(o)) / 32768;
    }
    if (!read) throw new Error('unsupported encoding: ' + fmtName);

    const frame = bps * ch;
    const frames = Math.floor(dataLen / frame);
    const samples = new Float32Array(frames);
    for (let i = 0, o = dataOff; i < frames; i++, o += frame) {
      let sum = 0;
      for (let c = 0; c < ch; c++) {
        const x = read(o + c * bps);
        if (x === x) sum += x;  // skip NaN from corrupt float data
      }
      samples[i] = Math.max(-1, Math.min(1, sum / ch));
    }
    return { samples, rate: fmt.rate };
  }

  function mulaw(u) {
    u = ~u & 0xFF;
    const t = (((u & 0x0F) << 3) + 0x84) << ((u & 0x70) >> 4);
    return (u & 0x80) ? 0x84 - t : t - 0x84;
  }

  function alaw(a) {
    a ^= 0x55;
    const seg = (a & 0x70) >> 4;
    let t = (a & 0x0F) << 4;
    t = seg === 0 ? t + 8 : ((t + 0x108) << (seg - 1));
    return (a & 0x80) ? t : -t;
  }

  const IMA_STEPS = [7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,66,73,80,88,97,107,118,
    130,143,157,173,190,209,230,253,279,307,337,371,408,449,494,544,598,658,724,796,876,963,1060,1166,1282,1411,
    1552,1707,1878,2066,2272,2499,2749,3024,3327,3660,4026,4428,4871,5358,5894,6484,7132,7845,8630,9493,10442,
    11487,12635,13899,15289,16818,18500,20350,22385,24623,27086,29794,32767];
  const IMA_INDEX = [-1,-1,-1,-1,2,4,6,8];

  // IMA/DVI ADPCM (format 0x11), as written by many voice recorders.
  function decodeImaAdpcm(v, off, len, fmt) {
    const ch = fmt.channels, block = fmt.align;
    if (!block || block <= 4 * ch) throw new Error('IMA ADPCM block size is invalid');
    const perBlock = (fmt.size >= 20 && v.getUint16(fmt.body + 18, true)) || ((block - 4 * ch) * 2 / ch + 1);
    const blocks = Math.ceil(len / block);
    const out = new Float32Array(blocks * perBlock);
    let n = 0;
    for (let b = 0; b < blocks; b++) {
      const base = off + b * block, end = Math.min(off + len, base + block);
      if (end - base < 4 * ch) break;
      let got = perBlock;
      for (let c = 0; c < ch; c++) {
        let pred = v.getInt16(base + 4 * c, true), idx = Math.min(88, v.getUint8(base + 4 * c + 2));
        out[n] += pred / 32768 / ch;
        let i = 1;
        // After the headers, each channel's nibbles come in 4-byte groups, interleaved by channel.
        for (let g = base + 4 * ch + 4 * c; g + 4 <= end && i < perBlock; g += 4 * ch) {
          for (let k = 0; k < 8 && i < perBlock; k++, i++) {
            const nib = (v.getUint8(g + (k >> 1)) >> ((k & 1) * 4)) & 0x0F;
            const step = IMA_STEPS[idx];
            let diff = step >> 3;
            if (nib & 1) diff += step >> 2;
            if (nib & 2) diff += step >> 1;
            if (nib & 4) diff += step;
            pred = Math.max(-32768, Math.min(32767, (nib & 8) ? pred - diff : pred + diff));
            idx = Math.max(0, Math.min(88, idx + IMA_INDEX[nib & 7]));
            out[n + i] += pred / 32768 / ch;
          }
        }
        got = Math.min(got, i);
      }
      n += got;
    }
    return out.subarray(0, n);
  }

  const MS_ADAPT = [230,230,230,230,307,409,512,614,768,614,512,409,307,230,230,230];
  const MS_COEFS = [[256,0],[512,-256],[0,0],[192,64],[240,0],[460,-208],[392,-232]];

  // Microsoft ADPCM (format 0x02).
  function decodeMsAdpcm(v, off, len, fmt) {
    const ch = fmt.channels, block = fmt.align;
    if (!block || block <= 7 * ch) throw new Error('MS ADPCM block size is invalid');
    let perBlock = (block - 7 * ch) * 2 / ch + 2, coefs = MS_COEFS;
    if (fmt.size >= 22) {
      perBlock = v.getUint16(fmt.body + 18, true) || perBlock;
      const num = v.getUint16(fmt.body + 20, true);
      if (num && fmt.size >= 22 + num * 4) {
        coefs = [];
        for (let k = 0; k < num; k++) coefs.push([v.getInt16(fmt.body + 22 + 4 * k, true), v.getInt16(fmt.body + 24 + 4 * k, true)]);
      }
    }
    const blocks = Math.ceil(len / block);
    const out = new Float32Array(blocks * perBlock);
    let n = 0;
    for (let b = 0; b < blocks; b++) {
      const base = off + b * block, end = Math.min(off + len, base + block);
      if (end - base < 7 * ch) break;
      const co = [], delta = [], s1 = [], s2 = [];
      for (let c = 0; c < ch; c++) {
        co[c]    = coefs[Math.min(coefs.length - 1, v.getUint8(base + c))];
        delta[c] = v.getInt16(base + ch + 2 * c, true);
        s1[c]    = v.getInt16(base + 3 * ch + 2 * c, true);
        s2[c]    = v.getInt16(base + 5 * ch + 2 * c, true);
        out[n]     += s2[c] / 32768 / ch;
        out[n + 1] += s1[c] / 32768 / ch;
      }
      let i = 2, c = 0;
      // Nibbles are high-first and interleaved across channels.
      for (let p = base + 7 * ch; p < end && i < perBlock; p++) {
        for (const nib of [v.getUint8(p) >> 4, v.getUint8(p) & 0x0F]) {
          const sn = nib & 8 ? nib - 16 : nib;
          let pred = ((s1[c] * co[c][0]) + (s2[c] * co[c][1])) >> 8;
          pred = Math.max(-32768, Math.min(32767, pred + sn * delta[c]));
          s2[c] = s1[c]; s1[c] = pred;
          delta[c] = Math.max(16, (MS_ADAPT[nib] * delta[c]) >> 8);
          out[n + i] += pred / 32768 / ch;
          if (++c === ch) { c = 0; i++; if (i >= perBlock) break; }
        }
      }
      n += i;
    }
    return out.subarray(0, n);
  }


  const WORKER_SRC = `
    import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2';
    env.allowLocalModels = false;

    const MODEL = 'Xenova/whisper-base.en';
    const SAMPLE_RATE = 16000;
    const CHUNK_SECONDS = 28;   // stay safely under Whisper's 30s window

    let transcriberPromise = null;
    function getTranscriber() {
      if (!transcriberPromise) {
        transcriberPromise = pipeline('automatic-speech-recognition', MODEL, {
          progress_callback: (p) => {
            if (p.status === 'progress' && p.total) {
              const pct = Math.round((p.loaded / p.total) * 100);
              postMessage({ type: 'progress', message: 'Downloading speech model (first time only)… ' + pct + '%', pct: pct * 0.3 });
            } else if (p.status === 'ready') {
              postMessage({ type: 'progress', message: 'Model ready — starting…', pct: 30 });
            }
          }
        });
        transcriberPromise.catch(() => { transcriberPromise = null; }); // allow a retry after a failed download
      }
      return transcriberPromise;
    }

    self.onmessage = async (e) => {
      const { id, samples } = e.data;
      try {
        const transcriber = await getTranscriber();
        const chunkLen = CHUNK_SECONDS * SAMPLE_RATE;
        const totalChunks = Math.max(1, Math.ceil(samples.length / chunkLen));
        let combined = '';
        for (let i = 0; i < totalChunks; i++) {
          const start = i * chunkLen;
          const chunk = samples.subarray(start, Math.min(start + chunkLen, samples.length));
          const out = await transcriber(chunk);
          if (out && out.text) combined += out.text.trim() + ' ';
          postMessage({ id, type: 'progress', message: 'Transcribing… (' + (i + 1) + ' of ' + totalChunks + ')', pct: 30 + ((i + 1) / totalChunks) * 70 });
        }
        postMessage({ id, type: 'done', text: combined.trim() });
      } catch (err) {
        postMessage({ id, type: 'error', message: (err && err.message) ? err.message : String(err) });
      }
    };
  `;

  let worker = null;
  function getWorker() {
    if (!worker) {
      const blob = new Blob([WORKER_SRC], { type: 'application/javascript' });
      worker = new Worker(URL.createObjectURL(blob), { type: 'module' });
    }
    return worker;
  }

  // The worker handles one job at a time; further uploads wait their turn.
  let queue = Promise.resolve();
  let nextJob = 1;

  function runWorker(samples, onProgress) {
    return new Promise((resolve, reject) => {
      const w = getWorker();
      const id = nextJob++;
      const onMessage = (e) => {
        const msg = e.data;
        if (msg.id !== undefined && msg.id !== id) return;
        if (msg.type === 'progress') {
          if (onProgress) onProgress(msg.message, msg.pct);
        } else if (msg.type === 'done' || msg.type === 'error') {
          w.removeEventListener('message', onMessage);
          w.removeEventListener('error', onError);
          if (msg.type === 'done') resolve(msg.text);
          else reject(new Error(msg.message));
        }
      };
      const onError = (e) => {
        w.removeEventListener('message', onMessage);
        w.removeEventListener('error', onError);
        worker = null; // start fresh next time
        reject(new Error(e.message || 'the transcriber could not start (are you online for the first-time model download?)'));
      };
      w.addEventListener('message', onMessage);
      w.addEventListener('error', onError);
      const copy = samples.slice();
      w.postMessage({ id, samples: copy }, [copy.buffer]);
    });
  }

  async function transcribeFile(file, onProgress) {
    const job = queue.then(async () => {
      if (onProgress) onProgress('Decoding audio…', 0);
      const samples = await decodeTo16kMono(file);
      if (!samples.length) throw new Error('the file has no audio in it');
      return runWorker(samples, onProgress);
    });
    queue = job.catch(() => {});
    return job;
  }

  function isAudioFile(file) {
    return !!file && (/^(audio|video)\//.test(file.type || '')
      || /\.(wav|wave|bwf|rf64|m4a|mp3|ogg|oga|opus|webm|flac|aac|mp4|mov)$/i.test(file.name || ''));
  }

  window.FolioTranscribe = { transcribeFile, isAudioFile };
})();
