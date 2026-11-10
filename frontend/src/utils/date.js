// toISOString() is UTC, so for local midnight east of UTC it lands on the previous day.
export function getLocalDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// A time entry's day is saved as UTC midnight ("2026-11-09" -> 2026-11-09T00:00Z).
export function getEntryDateString(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}
