import { useEffect, useState } from 'react';
import { AccountInfo } from '@rookfall/protocol';
import { net } from '../net/client';

/** the signed-in account and whether the server is reachable; re-renders when either changes */
export function useAccount(): { account: AccountInfo | null; connected: boolean } {
  const [, force] = useState(0);
  useEffect(() => {
    const bump = () => force((n) => n + 1);
    const u = [net.on('account', bump), net.on('open', bump), net.on('close', bump)];
    return () => u.forEach((f) => f());
  }, []);
  return { account: net.account, connected: net.connected };
}
