// SPDX-License-Identifier: AGPL-3.0-only
/** Attendra's mark: a phone in a rounded square, the same shape as the website's logo, in the theme's brand colour. */
export function BrandMark({ className = 'size-6' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="9" className="fill-primary" />
      <path className="fill-on-primary" d="M11.2 8.5c.7-.4 1.6-.2 2 .5l1.7 3c.4.7.2 1.5-.4 2l-1.4 1c.9 1.9 2.4 3.4 4.3 4.3l1-1.4c.5-.6 1.3-.8 2-.4l3 1.7c.7.4.9 1.3.5 2l-.9 1.6c-.6 1-1.8 1.5-2.9 1.2-5.2-1.4-9.2-5.4-10.6-10.6-.3-1.1.2-2.3 1.2-2.9l.5-.3z" />
    </svg>
  );
}
