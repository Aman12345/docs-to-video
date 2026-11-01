// Spoken intro and outro for every video. Claude writes storyboard.intro / .outro / .checks when it
// plans a video; ready-made storyboards without them get these sensible defaults.

const lowerFirst = (s) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
const task = (title) => lowerFirst(String(title || 'do this').replace(/^how to\s+/i, '').replace(/[.!?]+$/, ''));
const list = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

export function introText(sb) {
  if (sb.intro) return sb.intro;
  const steps = sb.scenes.map((s) => lowerFirst(s.chapter));
  return `Here's how to ${task(sb.title)}, in ${steps.length} step${steps.length === 1 ? '' : 's'}: ${list(steps)}.`;
}

export function outroText(sb) {
  if (sb.outro) return sb.outro;
  return `That's it! You now know how to ${task(sb.title)}.`;
}

// Short "check your work" points shown on the closing card and in the written SOP.
export function checksFor(sb) {
  if (Array.isArray(sb.checks) && sb.checks.length) return sb.checks.slice(0, 4);
  return [];
}
