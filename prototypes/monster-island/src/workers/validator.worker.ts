import { harden, hostCreateBlobUrl, hostNow, hostPost, hostRevokeUrl } from './harden';
import { importDefault } from '../sim/island';
import { validateCandidate, type ValidationRequest } from '../sim/validator';

const listen = self.addEventListener.bind(self);
harden();

const loader = async (_id: string, source: string) => {
  const url = hostCreateBlobUrl(source);
  try {
    return await importDefault(url);
  } finally {
    hostRevokeUrl(url);
  }
};

listen('message', async (ev: MessageEvent<{ type: 'validate'; req: ValidationRequest }>) => {
  if (ev.data.type !== 'validate') return;
  try {
    const report = await validateCandidate(ev.data.req, { loader, now: hostNow, progress: (stage) => hostPost({ type: 'progress', stage }) });
    hostPost({ type: 'result', report });
  } catch (err) {
    hostPost({ type: 'crash', error: `${(err as Error).message}\n${(err as Error).stack ?? ''}` });
  }
});
