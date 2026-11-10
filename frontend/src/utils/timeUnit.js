const TIME_UNIT_SHORT = { hour: 'h', day: 'd', week: 'w', month: 'mo' };
export function unitLabel(unit) {
  return TIME_UNIT_SHORT[unit] || 'd';
}
