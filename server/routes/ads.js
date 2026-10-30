// HTTP API of the ad exchange (see lib/ads.js).
import { requireUser, requireRole, intParam } from '../lib/http.js';
import {
  listChannels, channelDetail, setFavorite, bookDeal, complain, myChannels, sellerChannel, createChannel, updateChannel,
  setChannelVisible, deleteChannel, listDeals, dealRow, dealView, decideDeal, cancelDeal, markPublished, reviewDeal,
  adminChannels, adminSetChannel, adminComplaints, adConfig, validateAdConfig
} from '../lib/ads.js';
import { audit } from '../lib/moderation.js';
import { now, DAY } from '../lib/time.js';

export function adsRoutes(r, { db, config }) {
  /* -------- Feed (anyone signed in) -------- */
  r.get('/api/ads/channels', (ctx) => listChannels(db, ctx.query, requireUser(ctx).id));
  r.get('/api/ads/channels/:id', (ctx) => channelDetail(db, intParam(ctx.params.id), requireUser(ctx)));
  r.post('/api/ads/channels/:id/favorite', (ctx) => {
    setFavorite(db, requireUser(ctx), intParam(ctx.params.id), Boolean(ctx.body?.on));
    return { ok: true };
  });
  r.post('/api/ads/channels/:id/deals', (ctx) => bookDeal(db, requireUser(ctx), intParam(ctx.params.id), ctx.body));
  r.post('/api/ads/channels/:id/complaints', (ctx) => complain(db, requireUser(ctx), intParam(ctx.params.id), ctx.body, { envAdmins: config.adminIds }));

  /* -------- Sellers -------- */
  r.get('/api/ads/my', (ctx) => {
    const cfg = adConfig(db);
    return { channels: myChannels(db, requireUser(ctx)), config: { cpm_good: cfg.cpm_good, cpm_ok: cfg.cpm_ok } };
  });
  r.get('/api/ads/my/:id', (ctx) => sellerChannel(db, requireUser(ctx), intParam(ctx.params.id)));
  r.post('/api/ads/my', (ctx) => createChannel(db, requireUser(ctx), ctx.body, { botUsername: config.botUsername }));
  r.put('/api/ads/my/:id', (ctx) => updateChannel(db, requireUser(ctx), intParam(ctx.params.id), ctx.body));
  r.post('/api/ads/my/:id/visibility', (ctx) => {
    setChannelVisible(db, requireUser(ctx), intParam(ctx.params.id), Boolean(ctx.body?.visible));
    return { ok: true };
  });
  r.delete('/api/ads/my/:id', (ctx) => {
    deleteChannel(db, requireUser(ctx), intParam(ctx.params.id));
    return { ok: true };
  });

  /* -------- Deals -------- */
  r.get('/api/ads/deals', (ctx) => {
    const user = requireUser(ctx);
    const as = ctx.query.as === 'seller' ? 'seller' : 'buyer';
    return { items: listDeals(db, user, as), as };
  });
  r.get('/api/ads/deals/:id', (ctx) => dealView(db, dealRow(db, intParam(ctx.params.id)), requireUser(ctx)));
  const act = (path, fn) => r.post(`/api/ads/deals/:id/${path}`, (ctx) => {
    const user = requireUser(ctx);
    const id = intParam(ctx.params.id);
    fn(user, id, ctx.body || {});
    return dealView(db, dealRow(db, id), user);
  });
  act('agree', (u, id) => decideDeal(db, u, id, true));
  act('decline', (u, id, b) => decideDeal(db, u, id, false, b.reason));
  act('cancel', (u, id) => cancelDeal(db, u, id));
  act('published', (u, id) => markPublished(db, u, id));
  act('review', (u, id, b) => reviewDeal(db, u, id, b));

  /* -------- Admins -------- */
  r.get('/api/admin/ads', (ctx) => {
    requireRole(ctx, 'admin');
    const since = now() - 30 * DAY;
    const n = (sql, ...p) => db.get(sql, ...p).n;
    return {
      channels: adminChannels(db),
      config: adConfig(db),
      summary: {
        active: n("SELECT COUNT(*) n FROM ad_channels WHERE status = 'active'"),
        review: n("SELECT COUNT(*) n FROM ad_channels WHERE status = 'review'"),
        verified: n('SELECT COUNT(*) n FROM ad_channels WHERE verified_at IS NOT NULL'),
        requests30: n('SELECT COUNT(*) n FROM ad_deals WHERE created_at > ?', since),
        agreed30: n("SELECT COUNT(*) n FROM ad_deals WHERE decided_at > ? AND status IN ('agreed', 'published', 'reviewed', 'failed')", since),
        reviews30: n('SELECT COUNT(*) n FROM ad_reviews WHERE created_at > ?', since)
      }
    };
  });
  r.get('/api/admin/ads/:id/complaints', (ctx) => { requireRole(ctx, 'admin'); return { items: adminComplaints(db, intParam(ctx.params.id)) }; });
  r.post('/api/admin/ads/:id/:action', (ctx) => {
    adminSetChannel(db, requireRole(ctx, 'admin'), intParam(ctx.params.id), ctx.params.action, ctx.body?.note);
    return { ok: true };
  });
  r.put('/api/admin/ads/config', (ctx) => {
    const a = requireRole(ctx, 'admin');
    const next = validateAdConfig(ctx.body);
    db.setSetting('ad_config', next);
    audit(db, a.id, 'settings.ads', 'settings', null, next);
    return { config: next };
  });
}
