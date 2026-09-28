/**
 * The editor's address without its `key` fragment parameter. The key is a write capability: once the
 * editor has kept it in sessionStorage it must leave the address bar, which tab lists, screenshots and
 * browser automation tools read and repeat.
 */
export function addressWithoutKey(pathname: string, search: string, hash: string): string {
  const fragment = new URLSearchParams(hash.replace(/^#/, ''));
  fragment.delete('key');
  const rest = fragment.toString();
  return `${pathname}${search}${rest ? `#${rest}` : ''}`;
}
