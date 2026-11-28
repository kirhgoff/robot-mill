export type LimitHit = { resetAt: Date; guessed: boolean; line: string };

const hourMs = 3_600_000;
const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const resetPhrase = /(?:resets|try again at)\s+(.+?)\.?\s*$/i;
const clock =
  /^(?:(?<month>[a-z]{3})[a-z]*\.? (?<day>\d{1,2})(?:[a-z]{2})?,?(?: (?<year>\d{4}))?,? (?:at )?)?(?<hour>\d{1,2})(?::(?<minute>\d{2}))? ?(?<meridiem>[ap]m)(?: \((?<zone>[^)]+)\))?$/i;

function partsIn(at: Date, zone?: string) {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(at);
  const value = (type: string) => Number(formatted.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute") };
}

function instantIn(year: number, month: number, day: number, hour: number, minute: number, zone?: string) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const seen = partsIn(new Date(guess), zone);
  return new Date(guess - (Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute) - guess));
}

function parseReset(text: string, now: Date) {
  const found = clock.exec(text.trim())?.groups;
  if (!found) return null;
  const zone = found.zone;
  try {
    const hour = (Number(found.hour) % 12) + (found.meridiem?.toLowerCase() === "pm" ? 12 : 0);
    const minute = Number(found.minute ?? 0);
    const today = partsIn(now, zone);
    if (found.month) {
      const month = months.indexOf(found.month.toLowerCase()) + 1;
      return month ? instantIn(Number(found.year ?? today.year), month, Number(found.day), hour, minute, zone) : null;
    }
    const at = instantIn(today.year, today.month, today.day, hour, minute, zone);
    return at > now ? at : new Date(at.getTime() + 24 * hourMs);
  } catch {
    return null;
  }
}

export function limitDetector(phrase: RegExp) {
  return (paneText: string, now: Date): LimitHit | null => {
    const line = phrase.exec(paneText)?.[0];
    if (line === undefined) return null;
    const reset = resetPhrase.exec(line)?.[1];
    const parsed = reset ? parseReset(reset, now) : null;
    return parsed ? { resetAt: parsed, guessed: false, line } : { resetAt: new Date(now.getTime() + hourMs), guessed: true, line };
  };
}
