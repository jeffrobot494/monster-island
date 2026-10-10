import type { AiProvider, AiRequest, AiResponse } from './ai-provider';

/**
 * Dev-only: a human plays the god. Decrees are canned; implement/repair open a panel where module source is
 * pasted (or a reference module is supplied automatically).
 */
export class ManualProvider implements AiProvider {
  readonly name = 'manual';
  constructor(private ask: (req: AiRequest) => Promise<string>) {}

  async complete(req: AiRequest): Promise<AiResponse> {
    if (req.role === 'propose') {
      const allowed = req.messages[0].content.match(/Allowed domains tonight: ([^\n.]+)/)?.[1]?.split(', ') ?? ['creatures'];
      const human = req.system.includes('THE MOST HIGH');
      return {
        data: {
          title: human ? 'War-hounds of the Most High' : 'The sweet fog',
          domain: allowed.includes(human ? 'creatures' : 'weather') ? (human ? 'creatures' : 'weather') : allowed[0],
          announcement: human
            ? 'And the Most High said, Let hounds walk beside my people and hunt the beasts. And it was so.'
            : 'And the god of the beasts said, Let a fog rise from the salt flats, sweet to my children and bitter to men. And it was so.',
          mechanic: 'Whatever module source is supplied.',
          visible: 'Depends on the module.',
          priestsPrayer: human ? '' : 'Hide us from the bronze one.',
        },
        usage: { input: 0, output: 0 },
      };
    }
    const source = await this.ask(req);
    return { data: { source, notes: 'supplied by hand' }, usage: { input: 0, output: 0 } };
  }
}
