import type { RankTier } from '@pocket-of-empire/protocol';
import type { IconId } from './Icon';

/** by unit type, in the order of UNIT_KEYS (i18n): shown where a unit has no rendered thumbnail */
export const UNIT_ICONS: IconId[] = ['unit-worker', 'unit-soldier', 'unit-archer', 'unit-catapult', 'unit-militia', 'unit-cavalry', 'unit-ram', 'unit-golem', 'unit-golem', 'unit-golem'];
/** by building type, in the order of BUILDING_KEYS: build-menu buttons and the building portrait */
export const BUILDING_ICONS: IconId[] = ['castle', 'house', 'barracks', 'forge', 'tower', 'fence', 'mine'];
/** by forge upgrade, in the order of UPGRADE_KEYS */
export const UPGRADE_ICONS: IconId[] = ['upg-melee', 'upg-ranged', 'upg-armor', 'upg-speed', 'upg-range', 'upg-gather'];
/** by ability, in the order of ABILITY_KEYS */
export const ABILITY_ICONS: IconId[] = ['abl-shield', 'abl-volley', 'abl-incendiary', 'abl-militia'];

/** ladder tiers by key; the protocol's own `icon` (an emoji) is the server's and is not drawn */
export const TIER_ICONS: Record<RankTier['key'], IconId> = {
  unranked: 'tier-unranked', bronze: 'tier-bronze', silver: 'tier-silver', gold: 'tier-gold',
  platinum: 'tier-platinum', diamond: 'tier-diamond', master: 'tier-master', grandmaster: 'tier-grandmaster',
};
