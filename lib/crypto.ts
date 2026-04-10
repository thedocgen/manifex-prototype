import { createHash } from 'crypto';

export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function shortSha(sha: string): string {
  return sha.slice(0, 12);
}
