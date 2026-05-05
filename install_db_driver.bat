@echo off
cd /d "%~dp0"
echo.
echo  Downloading prebuilt SQLite driver for Node.js...
echo.

:: Get Node.js module version
for /f "tokens=*" %%i in ('node -e "process.stdout.write(process.versions.modules)"') do set NODEMOD=%%i
for /f "tokens=*" %%i in ('node -e "process.stdout.write(process.version.slice(1).split('.')[0])"') do set NODEMAJ=%%i

echo  Node.js major: %NODEMAJ%
echo  Module version: %NODEMOD%
echo.

:: Try to download prebuilt binary directly using node
node -e "
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const tar = require('tar');  // won't work without tar module

const mod = process.versions.modules;
const ver = '11.10.0';
const url = 'https://github.com/WiseLibs/better-sqlite3/releases/download/v' + ver + '/better-sqlite3-v' + ver + '-node-v' + mod + '-win32-x64.tar.gz';

console.log('Fetching:', url);

const dest = 'bsq.tgz';
const file = fs.createWriteStream(dest);

function download(url, cb) {
  https.get(url, res => {
    if (res.statusCode === 302 || res.statusCode === 301) return download(res.headers.location, cb);
    res.pipe(file);
    file.on('finish', () => { file.close(); cb(null); });
  }).on('error', cb);
}

download(url, err => {
  if (err) { console.error('Download failed:', err.message); process.exit(1); }
  console.log('Downloaded. Extracting...');
  // Extract using built-in
  execSync('tar -xzf bsq.tgz -C node_modules/better-sqlite3/');
  fs.unlinkSync(dest);
  console.log('Done! SQLite driver installed.');
});
"

if errorlevel 1 (
  echo.
  echo  Auto-download failed. Installing via npm with build tools...
  npm install --build-from-source better-sqlite3
)

echo.
echo  Done! Now run: npm run setup-db
pause
