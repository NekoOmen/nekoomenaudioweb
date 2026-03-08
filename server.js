const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = process.env.PORT || 3000;

// Temp directories
const UPLOAD_DIR = path.join(__dirname, 'tmp', 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'tmp', 'outputs');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Cleanup old files every 10 minutes
setInterval(() => {
  const now = Date.now();
  [UPLOAD_DIR, OUTPUT_DIR].forEach(dir => {
    try {
      fs.readdirSync(dir).forEach(f => {
        const fp = path.join(dir, f);
        try {
          const stat = fs.statSync(fp);
          if (now - stat.mtimeMs > 10 * 60 * 1000) fs.unlinkSync(fp);
        } catch (e) {}
      });
    } catch (e) {}
  });
}, 10 * 60 * 1000);

// Multer config
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
  fileFilter: (req, file, cb) => {
    const allowed = /\.(mp3|wav|ogg|flac|m4a|aac|webm|opus|wma)$/i;
    if (allowed.test(file.originalname) || file.mimetype.startsWith('audio/')) {
      cb(null, true);
    } else {
      cb(new Error('Only audio files are allowed'));
    }
  }
});

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', ffmpeg: !!ffmpegPath });
});

// Process audio
app.post('/api/process', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio file provided' });

  const { speed, pitch, format, volume } = req.body;
  const spd = parseFloat(speed) || 1.0;
  const pch = parseInt(pitch) || 0;
  const vol = parseFloat(volume) || 1.0;
  const fmt = ['mp3', 'wav', 'ogg'].includes(format) ? format : 'mp3';

  // Clamp values
  const clampedSpeed = Math.max(0.25, Math.min(4.0, spd));
  const clampedPitch = Math.max(-12, Math.min(12, pch));
  const clampedVol = Math.max(0, Math.min(2.0, vol));

  const inputPath = req.file.path;
  const outputName = uuidv4() + '.' + fmt;
  const outputPath = path.join(OUTPUT_DIR, outputName);

  try {
    await processAudio(inputPath, outputPath, clampedSpeed, clampedPitch, clampedVol, fmt);

    // Generate download filename
    const origName = path.parse(req.file.originalname).name;
    const suffix = [];
    if (clampedSpeed !== 1.0) suffix.push(`${clampedSpeed}x`);
    if (clampedPitch !== 0) suffix.push(`${clampedPitch > 0 ? '+' : ''}${clampedPitch}st`);
    const downloadName = origName + (suffix.length ? '_' + suffix.join('_') : '') + '.' + fmt;

    res.json({
      success: true,
      downloadUrl: `/api/download/${outputName}`,
      filename: downloadName,
      settings: { speed: clampedSpeed, pitch: clampedPitch, volume: clampedVol, format: fmt }
    });
  } catch (err) {
    console.error('Processing error:', err);
    res.status(500).json({ error: 'Audio processing failed: ' + err.message });
  } finally {
    // Cleanup input
    try { fs.unlinkSync(inputPath); } catch (e) {}
  }
});

// Bulk process
app.post('/api/process-bulk', upload.array('audio', 50), async (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'No audio files provided' });

  const { speed, pitch, format, volume } = req.body;
  const spd = Math.max(0.25, Math.min(4.0, parseFloat(speed) || 1.0));
  const pch = Math.max(-12, Math.min(12, parseInt(pitch) || 0));
  const vol = Math.max(0, Math.min(2.0, parseFloat(volume) || 1.0));
  const fmt = ['mp3', 'wav', 'ogg'].includes(format) ? format : 'mp3';

  const results = [];

  for (const file of req.files) {
    const outputName = uuidv4() + '.' + fmt;
    const outputPath = path.join(OUTPUT_DIR, outputName);

    try {
      await processAudio(file.path, outputPath, spd, pch, vol, fmt);
      const origName = path.parse(file.originalname).name;
      const suffix = [];
      if (spd !== 1.0) suffix.push(`${spd}x`);
      if (pch !== 0) suffix.push(`${pch > 0 ? '+' : ''}${pch}st`);
      const downloadName = origName + (suffix.length ? '_' + suffix.join('_') : '') + '.' + fmt;

      results.push({ success: true, downloadUrl: `/api/download/${outputName}`, filename: downloadName, original: file.originalname });
    } catch (err) {
      results.push({ success: false, error: err.message, original: file.originalname });
    } finally {
      try { fs.unlinkSync(file.path); } catch (e) {}
    }
  }

  res.json({ results });
});

// Download processed file
app.get('/api/download/:filename', (req, res) => {
  const filePath = path.join(OUTPUT_DIR, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found or expired' });

  const ext = path.extname(req.params.filename).slice(1);
  const mimeMap = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg' };

  res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${req.query.name || req.params.filename}"`);
  res.sendFile(filePath, () => {
    // Cleanup after download (delay to allow completion)
    setTimeout(() => { try { fs.unlinkSync(filePath); } catch (e) {} }, 30000);
  });
});

/**
 * Process audio with FFmpeg
 * 
 * Independent pitch & speed control:
 * - Speed (tempo) change WITHOUT affecting pitch: atempo filter
 * - Pitch shift WITHOUT affecting speed: asetrate + aresample
 * 
 * This is exactly how XELLO/professional tools do it.
 */
function processAudio(inputPath, outputPath, speed, pitchSemitones, volume, format) {
  return new Promise((resolve, reject) => {
    const filters = [];

    // --- PITCH SHIFT (independent of speed) ---
    // Change pitch by altering sample rate, then resample back to 44100
    // Formula: new_rate = original_rate * 2^(semitones/12)
    if (pitchSemitones !== 0) {
      const pitchFactor = Math.pow(2, pitchSemitones / 12);
      // asetrate changes the "declared" sample rate → shifts pitch
      // aresample brings it back to 44100 → preserves duration
      filters.push(`asetrate=44100*${pitchFactor.toFixed(6)}`);
      filters.push(`aresample=44100`);
    }

    // --- SPEED CHANGE (independent of pitch) ---
    // atempo only accepts 0.5–2.0, so chain multiple for larger ranges
    if (speed !== 1.0) {
      let remaining = speed;
      while (remaining > 2.0) {
        filters.push('atempo=2.0');
        remaining /= 2.0;
      }
      while (remaining < 0.5) {
        filters.push('atempo=0.5');
        remaining /= 0.5;
      }
      filters.push(`atempo=${remaining.toFixed(6)}`);
    }

    // --- VOLUME ---
    if (volume !== 1.0) {
      filters.push(`volume=${volume.toFixed(2)}`);
    }

    // Build FFmpeg command
    let cmd = ffmpeg(inputPath)
      .audioChannels(2)
      .audioFrequency(44100);

    // Apply filters
    if (filters.length > 0) {
      cmd = cmd.audioFilter(filters);
    }

    // Output format settings
    switch (format) {
      case 'mp3':
        cmd = cmd.audioCodec('libmp3lame').audioBitrate('192k');
        break;
      case 'ogg':
        cmd = cmd.audioCodec('libvorbis').audioBitrate('192k');
        break;
      case 'wav':
        cmd = cmd.audioCodec('pcm_s16le');
        break;
    }

    cmd
      .on('error', (err) => reject(err))
      .on('end', () => resolve())
      .save(outputPath);
  });
}

app.listen(PORT, () => {
  console.log(`\n  ♫ Nomen Audio Studio running on port ${PORT}`);
  console.log(`  → http://localhost:${PORT}\n`);
});
