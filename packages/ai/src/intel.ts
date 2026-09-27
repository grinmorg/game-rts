import {
  ArmorType, BUILDINGS, BuildingType, DAMAGE_MATRIX, TOWER_GARRISON_DAMAGE, UNITS, UnitType, buildingMaxHp, Age,
} from '@rookfall/sim';

/**
 * A fighting force reduced to what decides a fight: how much damage it puts out, of which kind, and how much
 * of which armour it has to be cut through. Two forces are compared by Lanchester's square law - the side with
 * the larger damage x health wins, and wins by more than the plain ratio suggests - which is what makes a bot
 * wait for the army that wins instead of walking in with the one that almost does.
 *
 * Floats are fine here: only + - * / and sqrt, which IEEE makes the same on every engine.
 */
export class Force {
  /** raw damage per second by damage type, before armour */
  readonly dps = [0, 0, 0];
  /** damage per second that can only land on buildings (a ram's beam), by damage type */
  readonly siegeDps = [0, 0, 0];
  /** hit points by armour type */
  readonly hp = [0, 0, 0, 0];
  /** population in it, units only */
  pop = 0;
  count = 0;

  clear(): this {
    this.dps.fill(0); this.siegeDps.fill(0); this.hp.fill(0); this.pop = 0; this.count = 0;
    return this;
  }

  /** one unit; `hp` is what it has left, `dmgUp` the owner's attack upgrade level for its kind */
  addUnit(type: UnitType, hp: number, dmgUp = 0): void {
    const d = UNITS[type];
    const perSec = ((d.damage + dmgUp * 2) * 20) / d.cooldown;
    // a catapult's stone lands on a knot of men, not one of them
    const splash = d.aoe > 0 ? 1.6 : 1;
    if (d.buildingsOnly) this.siegeDps[d.damageType] += perSec;
    else this.dps[d.damageType] += perSec * splash;
    this.hp[d.armor] += hp;
    this.pop += d.pop; this.count++;
  }

  /** a watchtower or castle as a fighter: its shot, with the crew a tower may have inside */
  addDefence(type: BuildingType, hp: number, rangedUp: number, age: Age, garrison: number, dpsPct = 100): void {
    const def = BUILDINGS[type];
    if (def.damage <= 0) return;
    const dmg = def.damage + def.upgradeBonus * rangedUp + def.ageDamage * age + (type === BuildingType.Tower ? garrison * TOWER_GARRISON_DAMAGE : 0);
    this.dps[def.damageType] += (dmg * 20 * dpsPct) / (def.cooldown * 100);
    this.hp[ArmorType.Building] += hp;
    this.count++;
  }

  /** a building that shoots at nothing but still has to be knocked down before the fight is over */
  addStructure(type: BuildingType, age: Age): void {
    this.hp[ArmorType.Building] += buildingMaxHp(type, age);
  }

  add(o: Force): void {
    for (let i = 0; i < 3; i++) { this.dps[i] += o.dps[i]; this.siegeDps[i] += o.siegeDps[i]; }
    for (let i = 0; i < 4; i++) this.hp[i] += o.hp[i];
    this.pop += o.pop; this.count += o.count;
  }

  hpTotal(): number { return this.hp[0] + this.hp[1] + this.hp[2] + this.hp[3]; }

  /** damage per second this force really deals to `o`, spread over o's armour as o is made up */
  dpsVs(o: Force): number {
    const total = o.hpTotal();
    if (total <= 0) return 0;
    let sum = 0;
    for (let d = 0; d < 3; d++) {
      const raw = this.dps[d], siege = this.siegeDps[d];
      if (raw === 0 && siege === 0) continue;
      for (let a = 0; a < 4; a++) {
        if (o.hp[a] === 0) continue;
        const share = o.hp[a] / total;
        const mult = DAMAGE_MATRIX[d][a] / 100;
        sum += raw * share * mult;
        if (a === ArmorType.Building) sum += siege * share * mult;
      }
    }
    return sum;
  }

  /** seconds this force needs to grind `o` down to nothing, if nothing shot back */
  secondsToKill(o: Force): number {
    const d = this.dpsVs(o);
    return d <= 0 ? Infinity : o.hpTotal() / d;
  }
}

/**
 * How much stronger `a` is than `b`, as a ratio of square-law strengths: above 1 `a` wins, and at 1.5 it wins
 * keeping most of itself. An empty `b` is an infinitely good fight; an `a` with no damage is a hopeless one.
 */
export function fightRatio(a: Force, b: Force): number {
  const ha = a.hpTotal(), hb = b.hpTotal();
  if (hb <= 0) return Infinity;
  const da = a.dpsVs(b), db = b.dpsVs(a);
  if (da <= 0 || ha <= 0) return 0;
  if (db <= 0) return Infinity;
  return Math.sqrt((da * ha) / (db * hb));
}

