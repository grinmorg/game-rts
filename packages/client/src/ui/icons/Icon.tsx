import { useId } from 'react';
import { ICONS } from './icons.generated';

/**
 * Every icon the UI can draw: the SVG files in ./svg plus the aliases in ./aliases.json (game meanings that borrow
 * another drawing for now). Rebuild the registry with `node packages/client/scripts/build-icons.mjs`.
 */
export type IconId = keyof typeof ICONS;

const ID_TOKEN = /__ID__/g;
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** the icon's markup with its mask ids made unique to this copy: a hidden copy holding the first id could blank the rest */
function useIconMarkup(name: IconId, title?: string): { viewBox: string; html: string } {
  const def = ICONS[name];
  const uid = useId().replace(/[^\w-]/g, '');
  let html = def.body.includes('__ID__') ? def.body.replace(ID_TOKEN, `${name}-${uid}-`) : def.body;
  if (title) html = `<title>${xml(title)}</title>${html}`;
  return { viewBox: def.viewBox, html };
}

/**
 * An inline SVG icon, one glyph wide (`.icon`: 1em square), drawn in the text colour. Decorative by default
 * (aria-hidden: the button or line it sits in carries the words); with `title` it is an image with that name.
 */
export function Icon({ name, className, title }: { name: IconId; className?: string; title?: string }) {
  const { viewBox, html } = useIconMarkup(name, title);
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'} viewBox={viewBox} fill="currentColor"
      {...(title ? { role: 'img' } : { 'aria-hidden': true })}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** The same icon placed inside another SVG (a chart): user-space position and size instead of the text flow. */
export function SvgIcon({ name, x, y, size, className }: { name: IconId; x: number; y: number; size: number; className?: string }) {
  const { viewBox, html } = useIconMarkup(name);
  return <svg className={className} x={x} y={y} width={size} height={size} viewBox={viewBox} fill="currentColor" aria-hidden dangerouslySetInnerHTML={{ __html: html }} />;
}
