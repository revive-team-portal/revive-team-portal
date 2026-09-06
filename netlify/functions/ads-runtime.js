// Temporary: report the function runtime's architecture and limits, so the
// ffmpeg / whisper binaries get built for the right target. ?k=<run key>
const { authorizeRun } = require('./_adsauth');
const os = require('os');
const fs = require('fs');
const cp = require('child_process');

exports.handler = async (event) => {
  const auth = await authorizeRun(event);
  if (!auth.ok) return { statusCode: 403, body: 'nope' };
  const out = {
    arch: process.arch, platform: process.platform, node: process.version,
    cpus: os.cpus().length, cpu_model: (os.cpus()[0] || {}).model,
    total_mem_mb: Math.round(os.totalmem() / 1048576),
    free_mem_mb: Math.round(os.freemem() / 1048576),
    lambda_memory_mb: process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE || null,
    lambda_runtime: process.env.AWS_EXECUTION_ENV || null,
    tmpdir: os.tmpdir(),
  };
  try { const s = fs.statfsSync('/tmp'); out.tmp_free_mb = Math.round(s.bsize * s.bavail / 1048576); out.tmp_total_mb = Math.round(s.bsize * s.blocks / 1048576); } catch (e) { out.tmp_free_mb = 'err: ' + e.message; }
  try { out.uname = cp.execSync('uname -m -o').toString().trim(); } catch (e) { out.uname = 'err: ' + String(e.message).slice(0, 100); }
  try { out.libc = cp.execSync('ldd --version 2>&1 | head -1').toString().trim(); } catch (e) { out.libc = 'err'; }
  try { out.has_ffmpeg_already = cp.execSync('which ffmpeg || echo none').toString().trim(); } catch (e) { out.has_ffmpeg_already = 'err'; }
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(out, null, 1) };
};
