// Titles and the spoken intro / outro for every video. Claude writes storyboard.intro / .outro /
// .checks when it plans a video; ready-made storyboards without them get these defaults.
// Videos are framed as "How to … in Miter" unless the title already names the product or another site.

const lowerFirst = (s) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
// "Create a Reimbursement" -> "create a reimbursement" (Title Case to sentence case), keeping acronyms
// (CSV, AI) and the product name as they are.
function sentenceCase(t) {
  const words = t.split(' ');
  const titled = words.filter((w) => /^[A-Z][a-z]/.test(w)).length >= Math.max(2, Math.ceil(words.length * 0.5));
  if (!titled) return t;
  const keep = new RegExp(`^(${process.env.BRAND_NAME || 'Miter'}|AI|[A-Z0-9]{2,}.*)$`);
  return words.map((w, i) => (i > 0 && /^[A-Z][a-z]/.test(w) && !keep.test(w) ? w.toLowerCase() : w)).join(' ');
}
const task = (title) => lowerFirst(sentenceCase(String(title || 'do this').replace(/^how to\s+/i, '').replace(/[.!?]+$/, '')));
const list = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
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

export function introText(sb, brand) {
  if (sb.intro) return sb.intro;
  const steps = sb.scenes.map((s) => lowerFirst(s.chapter));
  return `Here's how to ${task(sb.title)}${inProduct(sb, brand)}, in ${steps.length} step${steps.length === 1 ? '' : 's'}: ${list(steps)}.`;
}

export function outroText(sb, brand) {
  if (sb.outro) return sb.outro;
  return `That's it! You can now ${task(sb.title)}${inProduct(sb, brand)}.`;
}

// One line under "You're all set" on the closing card.
export function recapLine(sb, brand) {
  return `You can now ${task(sb.title)}${inProduct(sb, brand)}.`;
}

// Short "check your work" points shown on the closing card and in the written SOP.
export function checksFor(sb) {
  if (Array.isArray(sb?.checks) && sb.checks.length) return sb.checks.slice(0, 4);
  return [];
}
