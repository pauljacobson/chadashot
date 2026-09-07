import type { ReaderSnapshot } from '../shared/reader.js';

const articleParagraphs = {
  quiet: `
    <p>The most useful corners of the internet rarely announce themselves. They are maintained, linked, and revisited by people who care more about continuity than reach.</p>
    <p>An RSS reader changes the shape of attention. It replaces an algorithmic invitation with a deliberate promise: show me what I chose, and let me decide what matters.</p>
    <p>That sounds modest. In practice it makes the reader feel less like a destination and more like a private desk: articles arrive, wait quietly, and leave without demanding anything in return.</p>
    <h2>A place for deliberate attention</h2>
    <p>Tools for reading should make it easy to keep a thought, follow a source, and return to the original context. Everything else can stay out of the way.</p>
  `,
  tools: `
    <p>A good tool is present when you need it and nearly invisible when you do not. It reduces the number of decisions between an intention and an outcome.</p>
    <p>That is especially important for reading. Typography, navigation, saving, and annotation should support the text instead of competing with it.</p>
  `,
  protocols: `
    <p>Protocols are promises that outlive any one interface. They let people choose different software without giving up the relationships or collections they have already built.</p>
    <p>RSS remains a wonderfully ordinary example: a publisher exposes a feed, an aggregator remembers it, and a reader can present it in a way that suits one person.</p>
  `,
  garden: `
    <p>Reading is less about finishing a queue than choosing what deserves to stay with us. A small collection, tended regularly, can be more nourishing than an endless stream.</p>
    <p>The practice is not one of capture alone. It is also remembering, connecting, and occasionally letting something go.</p>
  `,
};

export const fixtureSnapshot: ReaderSnapshot = {
  generatedAt: new Date().toISOString(),
  source: 'fixture',
  folders: [
    { id: 'technology', title: 'Technology', unreadCount: 8 },
    { id: 'writing', title: 'Writing', unreadCount: 4 },
    { id: 'wordpress', title: 'WordPress', unreadCount: 6 },
  ],
  subscriptions: [
    { id: 'feed/infrequently', title: 'Infrequently Noted', url: 'https://example.com/infrequently.xml', siteUrl: 'https://example.com/infrequently', iconUrl: '/feed-icons/infrequently.svg', folderIds: ['writing'], unreadCount: 4 },
    { id: 'feed/dense', title: 'Dense Discovery', url: 'https://example.com/dense.xml', siteUrl: 'https://example.com/dense', iconUrl: '/feed-icons/dense.svg', folderIds: ['technology'], unreadCount: 8 },
    { id: 'feed/connected', title: 'Connected Places', url: 'https://example.com/connected.xml', siteUrl: 'https://example.com/connected', iconUrl: '/feed-icons/connected.svg', folderIds: ['technology'], unreadCount: 0 },
    { id: 'feed/marginalian', title: 'The Marginalian', url: 'https://example.com/marginalian.xml', siteUrl: 'https://example.com/marginalian', iconUrl: '/feed-icons/marginalian.svg', folderIds: ['writing'], unreadCount: 0 },
  ],
  articles: [
    {
      id: 'fixture-quiet-web',
      feedId: 'feed/infrequently',
      folderIds: ['writing'],
      title: 'The quiet web is still here',
      author: 'Mara Bell',
      source: 'Infrequently Noted',
      canonicalUrl: 'https://example.com/the-quiet-web',
      publishedAt: '2026-09-07T07:30:00.000Z',
      readingMinutes: 8,
      summary: 'The most useful corners of the internet rarely announce themselves. They are maintained, linked, and revisited.',
      contentHtml: articleParagraphs.quiet,
      read: false,
      starred: false,
    },
    {
      id: 'fixture-room-for-thought',
      feedId: 'feed/dense',
      folderIds: ['technology'],
      title: 'Tools should leave room for thought',
      author: 'Kai Brach',
      source: 'Dense Discovery',
      canonicalUrl: 'https://example.com/tools-and-thought',
      publishedAt: '2026-09-07T06:15:00.000Z',
      readingMinutes: 5,
      summary: 'A collection of small products that favour clarity, directness, and a little less attention capture.',
      contentHtml: articleParagraphs.tools,
      read: false,
      starred: true,
    },
    {
      id: 'fixture-protocols',
      feedId: 'feed/connected',
      folderIds: ['technology'],
      title: 'Protocols make better neighbourhoods',
      author: 'Nadia Eghbal',
      source: 'Connected Places',
      canonicalUrl: 'https://example.com/protocol-neighbourhoods',
      publishedAt: '2026-09-06T09:00:00.000Z',
      readingMinutes: 11,
      summary: 'What changes when identity and publishing are shared foundations instead of features owned by one product?',
      contentHtml: articleParagraphs.protocols,
      read: true,
      starred: false,
    },
    {
      id: 'fixture-garden',
      feedId: 'feed/marginalian',
      folderIds: ['writing'],
      title: 'A small garden of attention',
      author: 'Maria Popova',
      source: 'The Marginalian',
      canonicalUrl: 'https://example.com/garden-of-attention',
      publishedAt: '2026-09-05T12:00:00.000Z',
      readingMinutes: 6,
      summary: 'Reading is less about finishing a queue than choosing what deserves to stay with us.',
      contentHtml: articleParagraphs.garden,
      read: true,
      starred: true,
    },
  ],
};
