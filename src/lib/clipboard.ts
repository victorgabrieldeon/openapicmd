import { spawn } from 'node:child_process';

/** Copy text to system clipboard. Returns true on success. */
export async function copyToClipboard(text: string): Promise<boolean> {
  // Ordered by preference; clip.exe works in WSL
  const candidates = [
    ['xclip', '-selection', 'clipboard'],
    ['xsel', '--clipboard', '--input'],
    ['wl-copy'],
    ['clip.exe'],
  ];

  for (const [bin, ...args] of candidates) {
    if (!bin) continue;
    const ok = await trySpawn(bin, args, text);
    if (ok) return true;
  }
  return false;
}

function trySpawn(bin: string, args: string[], input: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const proc = spawn(bin, args, { stdio: ['pipe', 'ignore', 'ignore'] });
      proc.on('error', () => resolve(false));
      proc.on('close', (code) => resolve(code === 0));
      proc.stdin.write(input, 'utf8');
      proc.stdin.end();
    } catch {
      resolve(false);
    }
  });
}
