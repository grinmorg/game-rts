import { MapIssueCode } from '@rookfall/sim';
import { TKey } from '../i18n';
import { MapRequestError } from '../net/maps';

/** the message for a failed map request */
export function mapErrorKey(e: unknown): TKey {
  const code = e instanceof MapRequestError ? e.code : 'timeout';
  const keys: Record<string, TKey> = {
    offline: 'mapErrOffline', timeout: 'mapErrOffline', noProfile: 'mapErrOffline', invalid: 'mapErrInvalid', tooBig: 'mapErrTooBig',
    tooMany: 'mapErrTooMany', throttled: 'mapErrThrottled', notFound: 'mapErrNotFound', notOwner: 'mapErrNotFound', notValid: 'mapErrNotValid',
    ownMap: 'mapErrOwnMap',
  };
  return keys[code] ?? 'rejGeneric';
}

export const ISSUE_KEYS: Record<MapIssueCode, TKey> = {
  size: 'issueSize', fewZones: 'issueFewZones', zoneStarts: 'issueZoneStarts', tooManyMines: 'issueTooManyMines',
  startEdge: 'issueStartEdge', startBlocked: 'issueStartBlocked', startOverlap: 'issueStartOverlap',
  mineEdge: 'issueMineEdge', mineBlocked: 'issueMineBlocked', mineOverlap: 'issueMineOverlap', unreachable: 'issueUnreachable',
  noName: 'issueNoName', noGold: 'issueNoGold', mineUnreachable: 'issueMineUnreachable',
};

/** "128×96" */
export function sizeLabel(w: number, h: number): string { return `${w}×${h}`; }
