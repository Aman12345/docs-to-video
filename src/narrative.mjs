// Titles and the spoken intro / outro for every video. Claude writes storyboard.intro / .outro /
// .checks when it plans a video; ready-made storyboards without them get these defaults.
// Videos are framed as "How to … in Miter" unless the title already names the product or another site.

const lowerFirst = (s) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
const task = (title) => lowerFirst(String(title || 'do this').replace(/^how to\s+/i, '').replace(/[.!?]+$/, ''));
const productName = (brand) => brand?.name || process.env.BRAND_NAME || 'Miter';

// "in Miter" is added only for the product's own screens, and only if the title doesn't already say
// where it happens ("… on Wikipedia", "… with Miter AI").
function inProduct(sb, brand) {
  const name = productName(brand);
  if (new RegExp(`\\b${name}\\b`, 'i').test(sb.title || '')) return '';
  if (/\b(on|in|at|using|via)\s+[A-Z]/.test(sb.title || '')) return '';
  const url = String(sb.startUrl || '');
  const ownApp = !/^https?:/i.test(url) || new RegExp(name, 'i').test(url) || !!sb.login;
  return ownApp ? ` in ${name}` : '';
}

export function displayTitle(sb, brand) {
  return `How to ${task(sb.title)}${inProduct(sb, brand)}`;
}

// Short opening: the outcome and how many steps. The steps themselves are listed on the intro card,
// so the voice doesn't read them out (don't narrate what's already on screen).
const NUM = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
export function introText(sb, brand) {
  if (sb.intro) return sb.intro;
  const n = sb.scenes.filter((s) => !s.check).length; // the "Check your work" ending isn't counted as a step
  return `Here's how to ${task(sb.title)}${inProduct(sb, brand)}. It takes ${NUM[n] || n} quick step${n === 1 ? '' : 's'}.`;
}

// The video ends on one short line, never a recap of the steps.
export function outroText(sb, brand) {
  return `And that's how you ${task(sb.title)}${inProduct(sb, brand)}.`;
}

// The line under "That's it!" on the closing card.
export function recapLine(sb, brand) {
  return `That's how you ${task(sb.title)}${inProduct(sb, brand)}.`;
}

// Short "check your work" points shown on the closing card and in the written SOP.
export function checksFor(sb) {
  if (Array.isArray(sb?.checks) && sb.checks.length) return sb.checks.slice(0, 4);
  return [];
}
