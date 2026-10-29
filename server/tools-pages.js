'use strict';

// The free fixture tools (/tools, /tools/round-robin, …): pages people find
// when they search for a fixture generator. Each page is the tool itself
// (public/tools.js, using the same draw logic as real tournaments in
// public/formats.js), a short how-to and FAQs, and a way to run the same
// draw live on Tonament.

const TOOLS = {
  'round-robin': {
    name: 'Round robin generator',
    title: 'Round Robin Fixture Generator — Free, Printable Schedule',
    description: 'Free round robin generator: paste your players or teams, split them into groups and get every round\'s fixtures, byes and match count. Print it, or run it live on Tonament.',
    h1: ['Round robin ', 'fixture generator'],
    lead: 'Paste your players, pairs or teams. Get balanced groups and a fixture list where everyone plays everyone — round by round, with byes, ready to print or run live.',
    steps: [
      ['Paste your names', 'One player, pair or team per line. Put your strongest first if you want them in different groups.'],
      ['Choose the groups', 'One group where everyone plays everyone, or groups of 3 to 6. Groups are filled in a snake order, so the top seeds are spread out.'],
      ['Print or run it live', 'Print the fixtures for the wall, or run the same draw on Tonament: scores go live and the standings work themselves out.'],
    ],
    faqs: [
      ['How many matches are in a round robin?', 'For n players it is n × (n − 1) ÷ 2. Six players play 15 matches; eight play 28. Groups cut that down: 16 players in four groups of four play 24 matches instead of 120.'],
      ['How many rounds does a round robin take?', 'n − 1 rounds for an even number of players, n rounds for an odd number (one player sits out each round with a bye).'],
      ['What happens with an odd number of players?', 'Each round one player has a bye. Over the whole round robin everyone gets exactly one bye and plays everyone else once.'],
      ['How are the groups made?', 'In snake order: 1st, 2nd, 3rd, 4th into groups A–D, then 5th to 8th back from D to A, and so on. With your list in seeding order, the top seeds land in different groups and group sizes differ by at most one.'],
      ['Can I add a knockout after the groups?', 'Yes. On Tonament choose League + Knockout: the top one or two of each group go into a seeded knockout, kept apart from their own group in the first round.'],
    ],
    related: ['knockout-bracket', 'split-by-level'],
    guide: ['round-robin-vs-knockout', 'Round robin vs knockout: which format to choose'],
  },
  'knockout-bracket': {
    name: 'Knockout bracket maker',
    title: 'Knockout Bracket Maker — Free Seeded Draw with Byes',
    description: 'Free knockout bracket maker: paste your players in seeding order and get a seeded single-elimination draw with byes for the top seeds. Print it or run it live on Tonament.',
    h1: ['Knockout ', 'bracket maker'],
    lead: 'Paste your players, pairs or teams in seeding order. Get a proper seeded draw — top seeds apart, byes to the top seeds — from the first round to the final.',
    steps: [
      ['Paste your names in seed order', 'Your top seed first. Unseeded? Tap Shuffle for a random draw.'],
      ['Get the bracket', 'The draw is filled to the next power of two (8, 16, 32…). Seeds 1 and 2 can only meet in the final; the spare places are byes for the top seeds.'],
      ['Print or run it live', 'Print the bracket, or run the same draw on Tonament: winners move on automatically and everyone follows the scores.'],
    ],
    faqs: [
      ['How many byes are there?', 'The bracket is the next power of two at or above your number of entries, and the gap is byes. 12 players: a 16-draw with 4 byes, given to seeds 1 to 4.'],
      ['Where do the seeds go?', 'Standard seeding positions: 1 at the top, 2 at the bottom, 3 and 4 in the other halves, and so on — so the best players meet as late as possible.'],
      ['How many matches does a knockout take?', 'One fewer than the number of entries: 12 players play 11 matches (the byes are not matches). It needs as many rounds as the bracket has halvings: 4 rounds for a 16-draw.'],
      ['Can I swap players after the draw?', 'On paper, with an eraser. On Tonament you can redo the draw until the first point is played, and give a walkover if someone never turns up.'],
    ],
    related: ['round-robin', 'split-by-level'],
    guide: ['how-to-run-a-badminton-tournament', 'How to run a badminton tournament'],
  },
  'split-by-level': {
    name: 'Split by level draw',
    title: 'Split an Open Event by Level — Free Group & Knockout Draw',
    description: 'Free draw maker for Open events with mixed levels: Beginner, Intermediate and Advanced play their own groups, and the level winners meet in the semis or the final.',
    h1: ['Split an Open event ', 'by level'],
    lead: 'An Open event with every level in it? Let each level play its own groups, then bring the level winners together in the semis — or two pools, lower and upper levels, that meet in the final.',
    steps: [
      ['Paste each level\'s names', 'Beginner, Beginner+, Intermediate and Advanced — leave a level empty if nobody plays it.'],
      ['Choose how the pools meet', 'One pool per level, whose winners meet in the semis; or two pools — the lower and upper levels — that meet in the final.'],
      ['Print or run it live', 'Print the groups and the knockout, or run it on Tonament, where you can still move a player to the right group until they\'ve played.'],
    ],
    faqs: [
      ['Why split an Open event by level?', 'Beginners rarely enjoy losing 21-4 to an advanced pair. Level pools give everyone close matches in the groups, while the knockout still crowns one Open champion.'],
      ['When do the levels meet?', 'With one pool per level, each level\'s winner reaches the semis, so the levels only meet there. With two pools, the lower and upper pools meet only in the final.'],
      ['What if a player is in the wrong level?', 'On Tonament, move them to another group until that group starts — their matches are redone and their level updated. You can also swap the semi pairings.'],
      ['Can I take more than one player from each group?', 'Yes — choose 2 to go through, and each pool plays off in its own part of the bracket before meeting the others.'],
    ],
    related: ['round-robin', 'knockout-bracket'],
    guide: ['split-open-event-by-level', 'Splitting an Open event by level'],
  },
};

function createToolPages({ sitePage, esc }) {
  const SIGN_UP = '/signup?next=%2Fnew';
  const faqLd = (faqs) => ({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faqs.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) });
  const appLd = (base, path, name, description) => ({
    '@context': 'https://schema.org', '@type': 'WebApplication', name, url: base + path, description,
    applicationCategory: 'SportsApplication', operatingSystem: 'Any (in the browser)', isAccessibleForFree: true,
    offers: { '@type': 'Offer', price: 0, priceCurrency: 'INR' }, publisher: { '@type': 'Organization', name: 'Tonament', url: base },
  });
  const card = (slug) => {
    const x = TOOLS[slug];
    return `<a class="card tool-card" href="/tools/${slug}"><strong>${esc(x.name)}</strong><span class="muted">${esc(x.lead)}</span></a>`;
  };

  function toolHtml({ base, slug }) {
    const x = TOOLS[slug];
    if (!x) return null;
    const path = `/tools/${slug}`;
    const body = `    <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> › <a href="/tools">Free tools</a> › <span>${esc(x.name)}</span></nav>
    <section class="hero tool-hero">
      <p class="eyebrow">Free tool · <b>No sign-up</b></p>
      <h1>${esc(x.h1[0])}<span class="accent">${esc(x.h1[1])}</span></h1>
      <p class="lead">${esc(x.lead)}</p>
    </section>

    <section class="card tool" id="tool" data-tool="${esc(slug)}">
      <noscript><p>This tool runs in your browser — turn on JavaScript to use it.</p></noscript>
    </section>

    <section>
      <h2 class="features-title">How it works</h2>
      <ol class="tool-steps">
        ${x.steps.map(([h, p]) => `<li><strong>${esc(h)}</strong><p>${esc(p)}</p></li>`).join('\n        ')}
      </ol>
    </section>

    <section class="hero hero-end">
      <h2>Skip the paper on the day.</h2>
      <p class="lead">Run the same draw on Tonament: entries and UPI fees, live scores on every phone, standings and brackets that update themselves — and you can still change anything on the day.</p>
      <p class="actions"><a class="btn btn-primary btn-lg" href="${SIGN_UP}">Run it live — free</a> <a class="btn btn-lg btn-ghost" href="/blog/from-paper-to-live">From paper to live</a></p>
    </section>

    <section>
      <h2 class="features-title">Questions</h2>
      <div class="faq-list">
        ${x.faqs.map(([q, a]) => `<details class="faq"><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('\n        ')}
      </div>
      <p>Read more: <a href="/blog/${esc(x.guide[0])}">${esc(x.guide[1])}</a></p>
    </section>

    <section>
      <h2 class="features-title">More free tools</h2>
      <div class="tool-cards">${x.related.map(card).join('')}</div>
    </section>`;
    return sitePage({
      base, path, title: `${x.title} | Tonament`, description: x.description, body,
      trail: [['Free tools', '/tools'], [x.name, path]],
      ld: [appLd(base, path, x.name, x.description), faqLd(x.faqs)],
      scripts: '\n  <script src="/formats.js"></script>\n  <script src="/tools.js"></script>',
    });
  }

  function toolsHubHtml({ base }) {
    const description = 'Free tournament tools: a round robin fixture generator, a seeded knockout bracket maker and a split-by-level draw for Open events. Print them, or run them live on Tonament.';
    const body = `    <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> › <span>Free tools</span></nav>
    <section class="hero">
      <p class="eyebrow">Free tools · <b>No sign-up</b></p>
      <h1>Free tournament <span class="accent">fixture tools</span></h1>
      <p class="lead">Make your groups, fixtures and brackets in seconds — the same draws Tonament makes for real tournaments. Print them for the wall, or run them live.</p>
    </section>
    <div class="tool-cards">${Object.keys(TOOLS).map(card).join('')}</div>
    <section class="hero hero-end">
      <h2>Run it live instead.</h2>
      <p class="lead">Entries, fees, fixtures, the order of play and live scores — free for up to <span data-free-limit>16</span> entries.</p>
      <p class="actions"><a class="btn btn-primary btn-lg" href="${SIGN_UP}">Sign up free</a> <a class="btn btn-lg btn-ghost" href="/features">All features</a></p>
    </section>`;
    return sitePage({
      base, path: '/tools', title: 'Free Tournament Fixture Tools — Round Robin, Knockout & Level Draws | Tonament', description, body,
      trail: [['Free tools', '/tools']],
      ld: [{ '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'Free tournament tools', url: `${base}/tools`, description,
        hasPart: Object.entries(TOOLS).map(([slug, x]) => ({ '@type': 'WebApplication', name: x.name, url: `${base}/tools/${slug}` })) }],
    });
  }

  return { toolHtml, toolsHubHtml, paths: ['/tools', ...Object.keys(TOOLS).map((s) => `/tools/${s}`)] };
}

module.exports = { TOOLS, createToolPages };
