/*  =============================================================================
    ANCHOR. — frontend application
    -----------------------------------------------------------------------------
    sections:
      1.  state + token storage
      2.  api helper (fetch wrapper with auth)
      3.  small render utilities (escape, stars, time, cover)
      4.  auth: load session, login, register, logout, change password
      5.  header user widget
      6.  data loading: albums cache
      7.  reviews page: toolbar (search/sort/filter) + grid
      8.  top albums page: podium + ranked list
      9.  single review page: body, notes bar, tags, comments
      10. comments: render tree, post, reply, delete
      11. likes: toggle
      12. profile page
      13. info page
      14. navigation / routing
      15. auth modal
      16. album form modal (admin) + cover upload
      17. generic confirm modal
      18. init
    ============================================================================= */

'use strict';

// ─── 1. state + token storage ───────────────────────────────────────────────
// The JWT lives in localStorage. That's standard for token auth and is NOT the
// same as the old "everything in localStorage" approach — all real data now
// lives in the server's SQLite database. The token is just the login session.

const TOKEN_KEY = 'anchor_token';

const state = {
  user: null,          // { id, username, is_admin } or null
  albums: [],          // cached album list
  currentSingleId: null,
  currentProfile: null,
  // reviews toolbar:
  search: '',
  sort: 'newest',      // newest | rating | alpha
  tagFilter: null,
};

function getToken() { return localStorage.getItem(TOKEN_KEY); }
function setToken(t) { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); }

// ─── 2. api helper ───────────────────────────────────────────────────────────

async function api(path, { method = 'GET', body, isForm = false } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;

  let payload;
  if (isForm) {
    payload = body; // FormData — let the browser set content-type
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const res = await fetch('/api' + path, { method, headers, body: payload });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }

  if (!res.ok) {
    const err = new Error((data && data.error) || ('request failed (' + res.status + ')'));
    err.status = res.status;
    throw err;
  }
  return data;
}

// ─── 3. render utilities ─────────────────────────────────────────────────────

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderStars(rating) {
  const full = Math.floor(rating);
  const half = rating - full >= 0.5;
  let out = '';
  for (let i = 0; i < full; i++) out += '★';
  if (half) out += '⯨';
  while (out.length < 5) out += '☆';
  return out.slice(0, 5);
}

// resolve a cover_url that may be an external URL or an /uploads/ path
function coverSrc(url) {
  return url || '';
}

// returns the cover markup, with a graceful fallback when the image fails
function coverImg(album, cls) {
  const src = coverSrc(album.cover_url);
  const label = escapeHtml(album.artist + ' — ' + album.title);
  if (!src) {
    return '<div class="cover-fallback">' + escapeHtml(album.title) + '</div>';
  }
  return '<img class="' + (cls || '') + '" src="' + escapeHtml(src) + '" alt="' + label + '" ' +
    'onerror="this.outerHTML=\'<div class=&quot;cover-fallback&quot;>' + escapeHtml(album.title).replace(/'/g, '') + '</div>\'">';
}

function timeAgo(iso) {
  if (!iso) return '';
  // server stores "YYYY-MM-DD HH:MM:SS" in UTC
  const then = new Date(iso.replace(' ', 'T') + 'Z');
  const sec = Math.floor((Date.now() - then.getTime()) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + 'm ago';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + 'h ago';
  const day = Math.floor(hr / 24);
  if (day < 30) return day + 'd ago';
  const mo = Math.floor(day / 30);
  if (mo < 12) return mo + 'mo ago';
  return Math.floor(mo / 12) + 'y ago';
}

function fmtScore(r) {
  return (Math.round(r * 10) / 10).toFixed(1);
}

// ─── 4. auth ─────────────────────────────────────────────────────────────────

async function loadSession() {
  if (!getToken()) { state.user = null; return; }
  try {
    const { user } = await api('/auth/me');
    state.user = user;
  } catch {
    state.user = null;
    setToken(null);
  }
}

async function doLogin(username, password) {
  const { user, token } = await api('/auth/login', { method: 'POST', body: { username, password } });
  setToken(token);
  state.user = user;
}

async function doRegister(username, password) {
  const { user, token } = await api('/auth/register', { method: 'POST', body: { username, password } });
  setToken(token);
  state.user = user;
}

function doLogout() {
  setToken(null);
  state.user = null;
  applyAdminClass();
  renderUserWidget();
  // if we were somewhere user-specific, bounce to reviews
  showTab('reviews');
}

function applyAdminClass() {
  document.body.classList.toggle('is-admin', !!(state.user && state.user.is_admin));
}

// ─── 5. header user widget ───────────────────────────────────────────────────

function renderUserWidget() {
  const el = document.getElementById('user-widget');
  if (state.user) {
    const badge = state.user.is_admin ? '<span class="admin-badge">admin</span>' : '';
    el.innerHTML =
      '<span class="username" data-profile="' + escapeHtml(state.user.username) + '">' +
        escapeHtml(state.user.username) + badge +
      '</span>' +
      '<button id="btn-change-pw">password</button>' +
      '<button id="btn-logout">log out</button>';
    el.querySelector('.username').onclick = () => openProfile(state.user.username);
    el.querySelector('#btn-logout').onclick = doLogout;
    el.querySelector('#btn-change-pw').onclick = openChangePassword;
  } else {
    el.innerHTML =
      '<button id="btn-login">log in</button>' +
      '<button id="btn-register">register</button>';
    el.querySelector('#btn-login').onclick = () => openAuthModal('login');
    el.querySelector('#btn-register').onclick = () => openAuthModal('register');
  }
}

// ─── 6. data loading ─────────────────────────────────────────────────────────

async function loadAlbums() {
  const { albums } = await api('/albums');
  state.albums = albums;
  return albums;
}

function albumById(id) {
  return state.albums.find(a => a.id === id);
}

// ─── 7. reviews page ─────────────────────────────────────────────────────────

function filteredSortedAlbums() {
  let list = state.albums.slice();

  if (state.tagFilter) {
    list = list.filter(a => a.tags.some(t => t.toLowerCase() === state.tagFilter.toLowerCase()));
  }

  if (state.search.trim()) {
    const q = state.search.trim().toLowerCase();
    list = list.filter(a =>
      a.title.toLowerCase().includes(q) ||
      a.artist.toLowerCase().includes(q) ||
      (a.genre || '').toLowerCase().includes(q) ||
      a.tags.some(t => t.toLowerCase().includes(q))
    );
  }

  switch (state.sort) {
    case 'rating': list.sort((a, b) => b.rating - a.rating || b.id - a.id); break;
    case 'alpha':  list.sort((a, b) => a.title.localeCompare(b.title)); break;
    case 'newest':
    default:       list.sort((a, b) => b.id - a.id); break;
  }
  return list;
}

function renderReviewsPage() {
  const page = document.getElementById('page-reviews');
  const list = filteredSortedAlbums();

  const adminNewBtn = '<button class="btn ghost admin-only" id="btn-new-review">+ new review</button>';

  const activeFilter = state.tagFilter
    ? '<span class="active-filter">tag: <strong>#' + escapeHtml(state.tagFilter) + '</strong>' +
      '<button id="clear-tag" title="clear">×</button></span>'
    : '';

  const toolbar =
    '<div class="toolbar">' +
      '<div class="search-wrap">' +
        '<input id="search-input" type="text" placeholder="search title, artist, tag…" value="' + escapeHtml(state.search) + '">' +
      '</div>' +
      '<select class="sort-select" id="sort-select">' +
        '<option value="newest"' + (state.sort === 'newest' ? ' selected' : '') + '>newest</option>' +
        '<option value="rating"' + (state.sort === 'rating' ? ' selected' : '') + '>highest rated</option>' +
        '<option value="alpha"'  + (state.sort === 'alpha'  ? ' selected' : '') + '>a → z</option>' +
      '</select>' +
      activeFilter +
    '</div>';

  let grid;
  if (list.length === 0) {
    grid = '<div class="empty-state">nothing here' + (state.search || state.tagFilter ? ' — try clearing filters' : ' yet') + '.</div>';
  } else {
    grid = '<div class="reviews-grid">' + list.map(cardHtml).join('') + '</div>';
  }

  page.innerHTML =
    '<div class="grid-header">' +
      '<div><div class="section-label">latest entries</div><h2>reviews</h2></div>' +
      adminNewBtn +
    '</div>' +
    toolbar +
    grid;

  // wire up
  const newBtn = page.querySelector('#btn-new-review');
  if (newBtn) newBtn.onclick = () => openAlbumForm(null);

  const search = page.querySelector('#search-input');
  search.oninput = (e) => {
    state.search = e.target.value;
    // re-render only the grid to keep focus in the input
    const target = state.tagFilter || state.search ? filteredSortedAlbums() : filteredSortedAlbums();
    const gridEl = page.querySelector('.reviews-grid');
    const emptyEl = page.querySelector('.empty-state');
    const html = target.length
      ? '<div class="reviews-grid">' + target.map(cardHtml).join('') + '</div>'
      : '<div class="empty-state">nothing here — try clearing filters.</div>';
    if (gridEl) gridEl.outerHTML = html; else if (emptyEl) emptyEl.outerHTML = html;
    wireCards(page);
  };

  page.querySelector('#sort-select').onchange = (e) => {
    state.sort = e.target.value;
    renderReviewsPage();
  };

  const clearTag = page.querySelector('#clear-tag');
  if (clearTag) clearTag.onclick = () => { state.tagFilter = null; renderReviewsPage(); };

  wireCards(page);
}

function cardHtml(a) {
  const draftCls = a.is_draft ? ' is-draft' : '';
  const tags = a.tags.slice(0, 3).map(t =>
    '<button class="tag" data-tag="' + escapeHtml(t) + '">' + escapeHtml(t) + '</button>'
  ).join(' ');
  return (
    '<article class="review-card' + draftCls + '" data-album="' + a.id + '">' +
      '<div class="cover">' + coverImg(a, '') + '</div>' +
      '<div class="body">' +
        '<div class="meta">' + escapeHtml(a.genre || '') + '</div>' +
        '<div class="title">' + escapeHtml(a.title) + '</div>' +
        '<div class="year">' + escapeHtml(a.artist) + ' · ' + (a.year || '') + '</div>' +
        '<div class="snippet">' + escapeHtml(a.snippet || '') + '</div>' +
        '<div class="footer">' +
          '<span class="stars">' + renderStars(a.rating) + '</span>' +
          '<span>♥ ' + a.likes + ' · ' + a.comments + ' 💬</span>' +
        '</div>' +
      '</div>' +
    '</article>'
  );
}

function wireCards(scope) {
  scope.querySelectorAll('.review-card').forEach(card => {
    card.onclick = (e) => {
      // clicking a tag inside the card shouldn't open the review
      if (e.target.closest('.tag')) return;
      openSingle(parseInt(card.dataset.album, 10));
    };
  });
  scope.querySelectorAll('.tag').forEach(tag => {
    tag.onclick = (e) => {
      e.stopPropagation();
      state.tagFilter = tag.dataset.tag;
      state.search = '';
      showTab('reviews');
    };
  });
}

// ─── 8. top albums page ──────────────────────────────────────────────────────

function renderTopPage() {
  const page = document.getElementById('page-top');
  // only published albums, ranked by rating then recency
  const ranked = state.albums
    .filter(a => !a.is_draft)
    .slice()
    .sort((a, b) => b.rating - a.rating || b.id - a.id);

  const top3 = ranked.slice(0, 3);
  const rest = ranked.slice(3);

  const medalOrder = [top3[1], top3[0], top3[2]]; // visual order: 2 - 1 - 3
  const rankOf = (a) => top3.indexOf(a) + 1;

  const podium = '<div class="podium">' + medalOrder.filter(Boolean).map(a => {
    const rank = rankOf(a);
    return (
      '<div class="podium-card rank-' + rank + '" data-album="' + a.id + '">' +
        '<div class="podium-rank">' + rank + '</div>' +
        '<div class="podium-cover-wrap">' + coverImg(a, '') + '</div>' +
        '<div class="podium-body">' +
          '<div class="meta">' + escapeHtml(a.artist) + '</div>' +
          '<div class="title">' + escapeHtml(a.title) + '</div>' +
          '<div class="score">' + fmtScore(a.rating) + ' / 5.0</div>' +
        '</div>' +
      '</div>'
    );
  }).join('') + '</div>';

  let restHtml = '';
  if (rest.length) {
    restHtml =
      '<div class="section-label">the rest</div><h2>all ranked</h2>' +
      '<div class="ranked-list">' +
      rest.map((a, i) =>
        '<div class="ranked-row" data-album="' + a.id + '">' +
          '<div class="rank">' + (i + 4) + '</div>' +
          '<div class="mini-cover">' + coverImg(a, '') + '</div>' +
          '<div class="info">' +
            '<div class="title-line">' + escapeHtml(a.title) + '</div>' +
            '<div class="sub-line">' + escapeHtml(a.artist) + ' · ' + (a.year || '') + '</div>' +
          '</div>' +
          '<div class="stars">' + renderStars(a.rating) + '</div>' +
          '<div class="score-num">' + fmtScore(a.rating) + '</div>' +
        '</div>'
      ).join('') +
      '</div>';
  }

  page.innerHTML =
    '<div class="section-label">ranked by score</div>' +
    '<h2>top 3 albums</h2>' +
    podium +
    restHtml;

  page.querySelectorAll('[data-album]').forEach(el => {
    el.onclick = () => openSingle(parseInt(el.dataset.album, 10));
  });
}

// ─── 9. single review page ───────────────────────────────────────────────────

async function openSingle(id) {
  state.currentSingleId = id;
  showTab('single', { skipRender: true });

  const page = document.getElementById('page-single');
  page.innerHTML = '<div class="empty-state">loading…</div>';

  let album, comments;
  try {
    const a = await api('/albums/' + id);
    album = a.album;
    const c = await api('/albums/' + id + '/comments');
    comments = c.comments;
  } catch (e) {
    page.innerHTML = '<button class="back-btn" id="back">‹ back</button>' +
      '<div class="empty-state">' + escapeHtml(e.message) + '</div>';
    page.querySelector('#back').onclick = () => showTab('reviews');
    return;
  }

  // keep cache fresh for this album
  const idx = state.albums.findIndex(x => x.id === album.id);
  if (idx >= 0) state.albums[idx] = album;

  const bodyParas = (album.body || '')
    .split(/\n\s*\n/)
    .map(p => '<p>' + escapeHtml(p.trim()).replace(/\n/g, '<br>') + '</p>')
    .join('');

  const tags = album.tags.map(t =>
    '<button class="tag" data-tag="' + escapeHtml(t) + '">' + escapeHtml(t) + '</button>'
  ).join(' ');

  const likeCls = album.liked ? 'like-btn liked' : 'like-btn';
  const likeLabel = album.liked ? 'liked' : 'like';

  const adminButtons = state.user && state.user.is_admin
    ? '<div class="form-actions admin-only" style="justify-content:flex-start">' +
        '<button class="btn" id="btn-edit">edit review</button>' +
        '<button class="btn danger" id="btn-delete">delete review</button>' +
        (album.is_draft
          ? '<button class="btn primary" id="btn-publish">publish</button>'
          : '<button class="btn ghost" id="btn-unpublish">unpublish (draft)</button>') +
      '</div>'
    : '';

  const draftNote = album.is_draft
    ? '<div class="login-prompt" style="border-color:var(--accent-soft);margin-bottom:1rem">this review is a <strong>draft</strong> — only you (admin) can see it.</div>'
    : '';

  page.innerHTML =
    '<button class="back-btn" id="back">‹ back</button>' +
    draftNote +
    '<div class="single-layout">' +
      '<div class="single-cover">' +
        coverImg(album, '') +
        '<div class="single-score"><span class="big">' + fmtScore(album.rating) + '</span><span class="small">out of 5.0</span></div>' +
      '</div>' +
      '<div class="single-content">' +
        '<div class="single-meta">' + escapeHtml(album.genre || '') + '</div>' +
        '<h2>' + escapeHtml(album.title) + '</h2>' +
        '<div class="artist">' + escapeHtml(album.artist) + '</div>' +
        '<div class="year">' + (album.year || '') + '</div>' +
        '<div class="stars">' + renderStars(album.rating) + '</div>' +
        '<div class="review-body">' + bodyParas +
          (album.verdict ? '<div class="verdict">' + escapeHtml(album.verdict) + '</div>' : '') +
        '</div>' +
        '<div class="notes-bar">' +
          '<button class="' + likeCls + '" id="like-btn"><span class="heart">♥</span> ' + likeLabel + '</button>' +
          '<span id="notes-count">' + album.likes + ' notes · ' + album.comments + ' 💬</span>' +
        '</div>' +
        '<div class="tags-row">' + tags + '</div>' +
        adminButtons +
        '<div class="comments-section" id="comments-section"></div>' +
      '</div>' +
    '</div>';

  page.querySelector('#back').onclick = () => { state.tagFilter = state.tagFilter; showTab('reviews'); };
  page.querySelector('#like-btn').onclick = () => toggleLike(album.id);

  page.querySelectorAll('.tag').forEach(t => {
    t.onclick = () => { state.tagFilter = t.dataset.tag; state.search = ''; showTab('reviews'); };
  });

  if (adminButtons) {
    const edit = page.querySelector('#btn-edit');
    const del  = page.querySelector('#btn-delete');
    const pub  = page.querySelector('#btn-publish');
    const unpub= page.querySelector('#btn-unpublish');
    if (edit) edit.onclick = () => openAlbumForm(album);
    if (del)  del.onclick  = () => confirmDeleteAlbum(album);
    if (pub)  pub.onclick  = () => togglePublish(album, false);
    if (unpub) unpub.onclick = () => togglePublish(album, true);
  }

  renderComments(album.id, comments);
}

async function togglePublish(album, makeDraft) {
  try {
    await api('/albums/' + album.id, { method: 'PUT', body: { ...album, is_draft: makeDraft } });
    await loadAlbums();
    openSingle(album.id);
  } catch (e) { alert(e.message); }
}

// ─── 10. comments ──────────────────────────────────────────────────────────

function renderComments(albumId, comments) {
  const el = document.getElementById('comments-section');
  if (!el) return;

  // build a one-level tree: top-level comments, each with its replies
  const tops = comments.filter(c => !c.parent_id);
  const repliesByParent = {};
  comments.filter(c => c.parent_id).forEach(c => {
    (repliesByParent[c.parent_id] = repliesByParent[c.parent_id] || []).push(c);
  });

  const commentHtml = (c, isReply) => {
    const cls = ['comment'];
    if (isReply) cls.push('reply');
    if (c.is_admin) cls.push('is-admin');
    if (state.user && c.user_id === state.user.id) cls.push('is-mine');

    const canDelete = state.user && (c.user_id === state.user.id || state.user.is_admin);
    const canReply = state.user && !isReply; // only reply to top-level

    const actions = [];
    if (canReply)  actions.push('<button data-reply="' + c.id + '">reply</button>');
    if (canDelete) actions.push('<button data-del="' + c.id + '">delete</button>');

    return (
      '<div class="' + cls.join(' ') + '">' +
        '<div class="comment-head">' +
          '<span><span class="author" data-profile="' + escapeHtml(c.username) + '">' + escapeHtml(c.username) + '</span>' +
            (c.is_admin ? ' <span class="admin-badge">admin</span>' : '') +
            ' <span class="when">' + timeAgo(c.created_at) + '</span></span>' +
          (actions.length ? '<span class="actions">' + actions.join('') + '</span>' : '') +
        '</div>' +
        '<div class="comment-body">' + escapeHtml(c.body) + '</div>' +
      '</div>' +
      '<div class="reply-mount" data-mount="' + c.id + '"></div>'
    );
  };

  let html = '<h3>comments (' + comments.length + ')</h3>';

  if (tops.length === 0) {
    html += '<div class="muted" style="margin-bottom:1rem">no comments yet.</div>';
  } else {
    html += tops.map(c => {
      let block = commentHtml(c, false);
      const replies = repliesByParent[c.id] || [];
      block += replies.map(r => commentHtml(r, true)).join('');
      return block;
    }).join('');
  }

  if (state.user) {
    html +=
      '<div class="comment-form">' +
        '<textarea id="comment-input" placeholder="say something…"></textarea>' +
        '<div><button class="btn primary" id="post-comment">post comment</button></div>' +
      '</div>';
  } else {
    html += '<div class="login-prompt">you need to <a id="login-link">log in</a> to comment.</div>';
  }

  el.innerHTML = html;

  // wire profile links
  el.querySelectorAll('[data-profile]').forEach(a => {
    a.onclick = () => openProfile(a.dataset.profile);
  });

  // delete buttons
  el.querySelectorAll('[data-del]').forEach(b => {
    b.onclick = async () => {
      if (!confirm('delete this comment?')) return;
      try {
        await api('/comments/' + b.dataset.del, { method: 'DELETE' });
        const { comments: fresh } = await api('/albums/' + albumId + '/comments');
        renderComments(albumId, fresh);
        refreshAlbumCounts(albumId);
      } catch (e) { alert(e.message); }
    };
  });

  // reply buttons → inject a reply form under the comment
  el.querySelectorAll('[data-reply]').forEach(b => {
    b.onclick = () => {
      const pid = b.dataset.reply;
      const mount = el.querySelector('[data-mount="' + pid + '"]');
      if (mount.querySelector('.reply-form')) { mount.innerHTML = ''; return; }
      mount.innerHTML =
        '<div class="reply-form">' +
          '<textarea placeholder="reply…"></textarea>' +
          '<div><button class="btn small primary">reply</button> ' +
          '<button class="btn small ghost cancel">cancel</button></div>' +
        '</div>';
      const ta = mount.querySelector('textarea');
      ta.focus();
      mount.querySelector('.cancel').onclick = () => { mount.innerHTML = ''; };
      mount.querySelector('.primary').onclick = async () => {
        const body = ta.value.trim();
        if (!body) return;
        try {
          await api('/albums/' + albumId + '/comments', { method: 'POST', body: { body, parent_id: pid } });
          const { comments: fresh } = await api('/albums/' + albumId + '/comments');
          renderComments(albumId, fresh);
          refreshAlbumCounts(albumId);
        } catch (e) { alert(e.message); }
      };
    };
  });

  // post comment
  const postBtn = el.querySelector('#post-comment');
  if (postBtn) {
    postBtn.onclick = async () => {
      const input = el.querySelector('#comment-input');
      const body = input.value.trim();
      if (!body) return;
      try {
        await api('/albums/' + albumId + '/comments', { method: 'POST', body: { body } });
        const { comments: fresh } = await api('/albums/' + albumId + '/comments');
        renderComments(albumId, fresh);
        refreshAlbumCounts(albumId);
      } catch (e) { alert(e.message); }
    };
  }

  const loginLink = el.querySelector('#login-link');
  if (loginLink) loginLink.onclick = () => openAuthModal('login');
}

// keep the notes-count line + cache in sync after comment/like changes
async function refreshAlbumCounts(albumId) {
  try {
    const { album } = await api('/albums/' + albumId);
    const idx = state.albums.findIndex(x => x.id === albumId);
    if (idx >= 0) state.albums[idx] = album;
    const nc = document.getElementById('notes-count');
    if (nc) nc.textContent = album.likes + ' notes · ' + album.comments + ' 💬';
  } catch { /* ignore */ }
}

// ─── 11. likes ─────────────────────────────────────────────────────────────

async function toggleLike(albumId) {
  if (!state.user) { openAuthModal('login'); return; }
  try {
    const { liked, likes } = await api('/albums/' + albumId + '/like', { method: 'POST' });
    const btn = document.getElementById('like-btn');
    if (btn) {
      btn.classList.toggle('liked', liked);
      btn.innerHTML = '<span class="heart">♥</span> ' + (liked ? 'liked' : 'like');
    }
    const idx = state.albums.findIndex(x => x.id === albumId);
    if (idx >= 0) { state.albums[idx].liked = liked; state.albums[idx].likes = likes; }
    const nc = document.getElementById('notes-count');
    if (nc) {
      const a = state.albums[idx];
      nc.textContent = likes + ' notes · ' + (a ? a.comments : 0) + ' 💬';
    }
  } catch (e) { alert(e.message); }
}

// ─── 12. profile page ────────────────────────────────────────────────────────

async function openProfile(username) {
  showTab('profile', { skipRender: true });
  const page = document.getElementById('page-profile');
  page.innerHTML = '<div class="empty-state">loading…</div>';

  let data;
  try {
    data = await api('/users/' + encodeURIComponent(username));
  } catch (e) {
    page.innerHTML = '<button class="back-btn" id="back">‹ back</button><div class="empty-state">' + escapeHtml(e.message) + '</div>';
    page.querySelector('#back').onclick = () => showTab('reviews');
    return;
  }

  const p = data.profile;
  const badge = p.is_admin ? '<span class="admin-badge">admin</span>' : '';

  const commentsHtml = data.comments.length
    ? data.comments.map(c =>
        '<div class="profile-comment">' +
          '<div class="on">on <a data-album="' + c.album_id + '">' + escapeHtml(c.album_title) + '</a> · ' + escapeHtml(c.album_artist) + ' · ' + timeAgo(c.created_at) + (c.parent_id ? ' · reply' : '') + '</div>' +
          '<div class="comment-body">' + escapeHtml(c.body) + '</div>' +
        '</div>'
      ).join('')
    : '<div class="muted">no comments yet.</div>';

  const likesHtml = data.likes.length
    ? '<div class="profile-likes-grid">' + data.likes.map(a =>
        '<div class="profile-like-card" data-album="' + a.id + '">' +
          '<div class="cover">' + coverImg(a, '') + '</div>' +
          '<div class="t">' + escapeHtml(a.title) + '</div>' +
          '<div class="a">' + escapeHtml(a.artist) + '</div>' +
        '</div>'
      ).join('') + '</div>'
    : '<div class="muted">no liked albums yet.</div>';

  page.innerHTML =
    '<button class="back-btn" id="back">‹ back</button>' +
    '<div class="profile-header">' +
      '<div class="section-label">profile</div>' +
      '<h2>' + escapeHtml(p.username) + ' ' + badge + '</h2>' +
      '<div class="profile-stats">' +
        '<span><strong>' + p.comment_count + '</strong> comments</span>' +
        '<span><strong>' + p.like_count + '</strong> likes</span>' +
        '<span>joined ' + timeAgo(p.created_at) + '</span>' +
      '</div>' +
    '</div>' +
    '<div class="profile-sub"><h3>liked albums</h3>' + likesHtml + '</div>' +
    '<div class="profile-sub"><h3>recent comments</h3>' + commentsHtml + '</div>';

  page.querySelector('#back').onclick = () => showTab('reviews');
  page.querySelectorAll('[data-album]').forEach(el => {
    el.onclick = () => openSingle(parseInt(el.dataset.album, 10));
  });
}

// ─── 13. info page ─────────────────────────────────────────────────────────

function renderInfoPage() {
  const page = document.getElementById('page-info');
  const published = state.albums.filter(a => !a.is_draft);
  const count = published.length;
  const avg = count ? published.reduce((s, a) => s + a.rating, 0) / count : 0;

  // tag frequencies
  const freq = {};
  published.forEach(a => a.tags.forEach(t => { freq[t] = (freq[t] || 0) + 1; }));
  const topTags = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 12);

  const tagCloud = topTags.length
    ? '<div class="tags-row">' + topTags.map(([t, n]) =>
        '<button class="tag" data-tag="' + escapeHtml(t) + '">' + escapeHtml(t) + ' (' + n + ')</button>'
      ).join(' ') + '</div>'
    : '';

  page.innerHTML =
    '<div class="section-label">about</div><h2>info</h2>' +
    '<div class="info-page">' +
      '<p>anchor is a personal space for music opinions. no algorithm, no affiliate links, no engagement bait — just records worth talking about and a place to talk about them.</p>' +
      '<p>make an account to leave comments and like reviews. that\'s it. no email, no confirmation.</p>' +
      '<div class="info-stats">' +
        '<div class="info-stat"><div class="v">' + count + '</div><div class="k">reviews</div></div>' +
        '<div class="info-stat"><div class="v">' + fmtScore(avg) + '</div><div class="k">avg score</div></div>' +
        '<div class="info-stat"><div class="v">' + Object.keys(freq).length + '</div><div class="k">unique tags</div></div>' +
      '</div>' +
      '<h3 style="margin-top:2rem">tags</h3>' + tagCloud +
    '</div>';

  page.querySelectorAll('.tag').forEach(t => {
    t.onclick = () => { state.tagFilter = t.dataset.tag; state.search = ''; showTab('reviews'); };
  });
}

// ─── 14. navigation / routing ────────────────────────────────────────────────

const PAGES = ['reviews', 'top', 'info', 'single', 'profile'];

function showTab(tab, { skipRender = false } = {}) {
  PAGES.forEach(p => {
    document.getElementById('page-' + p).classList.toggle('hidden', p !== tab);
  });
  // tab highlight for the main tabs AND the sidebar nav (both use data-tab)
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });
  document.querySelectorAll('#sb-nav button').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });

  if (skipRender) return;

  if (tab === 'reviews') renderReviewsPage();
  if (tab === 'top')     renderTopPage();
  if (tab === 'info')    renderInfoPage();
}

// after any data mutation, re-render whatever's on screen
function refreshAll() {
  applyAdminClass();
  renderUserWidget();
  const visible = PAGES.find(p => !document.getElementById('page-' + p).classList.contains('hidden')) || 'reviews';
  if (visible === 'single' && state.currentSingleId) openSingle(state.currentSingleId);
  else if (visible === 'profile' && state.currentProfile) openProfile(state.currentProfile);
  else showTab(visible);
}

// ─── 15. auth modal ──────────────────────────────────────────────────────────

function closeModal() { document.getElementById('modal-root').innerHTML = ''; }

function openAuthModal(mode) {
  const root = document.getElementById('modal-root');
  root.innerHTML =
    '<div class="modal-backdrop" id="backdrop">' +
      '<div class="modal fade-in">' +
        '<button class="modal-close" id="modal-close">×</button>' +
        '<div class="modal-tabs">' +
          '<button class="modal-tab" data-mode="login">log in</button>' +
          '<button class="modal-tab" data-mode="register">register</button>' +
        '</div>' +
        '<div class="form-field"><label>username</label><input id="auth-username" autocomplete="username"></div>' +
        '<div class="spacer"></div>' +
        '<div class="form-field"><label>password</label><input id="auth-password" type="password" autocomplete="current-password"></div>' +
        '<div class="form-help" id="auth-help"></div>' +
        '<div class="modal-error" id="auth-error"></div>' +
        '<div class="form-actions"><button class="btn primary" id="auth-submit"></button></div>' +
      '</div>' +
    '</div>';

  let current = mode || 'login';

  function paint() {
    root.querySelectorAll('.modal-tab').forEach(t => t.classList.toggle('active', t.dataset.mode === current));
    root.querySelector('#auth-submit').textContent = current === 'login' ? 'log in' : 'create account';
    root.querySelector('#auth-help').textContent = current === 'register'
      ? 'no email required. username 2–30 chars, password ≥ 6 chars.'
      : '';
    root.querySelector('#auth-password').autocomplete = current === 'login' ? 'current-password' : 'new-password';
  }
  paint();

  root.querySelectorAll('.modal-tab').forEach(t => {
    t.onclick = () => { current = t.dataset.mode; root.querySelector('#auth-error').classList.remove('show'); paint(); };
  });

  const submit = async () => {
    const u = root.querySelector('#auth-username').value.trim();
    const p = root.querySelector('#auth-password').value;
    const errEl = root.querySelector('#auth-error');
    errEl.classList.remove('show');
    try {
      if (current === 'login') await doLogin(u, p);
      else await doRegister(u, p);
      closeModal();
      refreshAll();
    } catch (e) {
      errEl.textContent = e.message;
      errEl.classList.add('show');
    }
  };

  root.querySelector('#auth-submit').onclick = submit;
  root.querySelector('#modal-close').onclick = closeModal;
  root.querySelector('#backdrop').onclick = (e) => { if (e.target.id === 'backdrop') closeModal(); };
  root.querySelector('#auth-password').onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  root.querySelector('#auth-username').onkeydown = (e) => { if (e.key === 'Enter') root.querySelector('#auth-password').focus(); };
  root.querySelector('#auth-username').focus();
}

function openChangePassword() {
  const root = document.getElementById('modal-root');
  root.innerHTML =
    '<div class="modal-backdrop" id="backdrop">' +
      '<div class="modal fade-in">' +
        '<button class="modal-close" id="modal-close">×</button>' +
        '<h3>change password</h3>' +
        '<div class="form-field"><label>current password</label><input id="cp-cur" type="password"></div>' +
        '<div class="spacer"></div>' +
        '<div class="form-field"><label>new password</label><input id="cp-new" type="password"></div>' +
        '<div class="form-help">at least 6 characters.</div>' +
        '<div class="modal-error" id="cp-error"></div>' +
        '<div class="form-actions"><button class="btn primary" id="cp-submit">update</button></div>' +
      '</div>' +
    '</div>';

  const errEl = root.querySelector('#cp-error');
  root.querySelector('#cp-submit').onclick = async () => {
    errEl.classList.remove('show');
    try {
      await api('/auth/change-password', { method: 'POST', body: {
        current_password: root.querySelector('#cp-cur').value,
        new_password: root.querySelector('#cp-new').value,
      }});
      closeModal();
      alert('password updated.');
    } catch (e) { errEl.textContent = e.message; errEl.classList.add('show'); }
  };
  root.querySelector('#modal-close').onclick = closeModal;
  root.querySelector('#backdrop').onclick = (e) => { if (e.target.id === 'backdrop') closeModal(); };
}

// ─── 16. album form modal (admin) ────────────────────────────────────────────

function openAlbumForm(album) {
  const isEdit = !!album;
  const a = album || { artist: '', title: '', year: new Date().getFullYear(), genre: '', rating: 4.5, cover_url: '', tags: [], snippet: '', body: '', verdict: '', is_draft: false };
  const root = document.getElementById('modal-root');

  root.innerHTML =
    '<div class="modal-backdrop" id="backdrop">' +
      '<div class="modal fade-in">' +
        '<button class="modal-close" id="modal-close">×</button>' +
        '<h3>' + (isEdit ? 'edit review' : 'new review') + '</h3>' +
        '<div class="form-row">' +
          '<div class="form-field"><label>artist</label><input id="f-artist" value="' + escapeHtml(a.artist) + '"></div>' +
          '<div class="form-field"><label>title</label><input id="f-title" value="' + escapeHtml(a.title) + '"></div>' +
        '</div>' +
        '<div class="form-row">' +
          '<div class="form-field"><label>year</label><input id="f-year" type="number" value="' + (a.year || '') + '"></div>' +
          '<div class="form-field"><label>genre</label><input id="f-genre" value="' + escapeHtml(a.genre || '') + '"></div>' +
        '</div>' +
        '<div class="form-row">' +
          '<div class="form-field"><label>rating (0–5, 0.5 step)</label><input id="f-rating" type="number" min="0" max="5" step="0.5" value="' + a.rating + '"></div>' +
          '<div class="form-field"><label>tags (comma separated)</label><input id="f-tags" value="' + escapeHtml(a.tags.join(', ')) + '"></div>' +
        '</div>' +
        '<div class="form-row single">' +
          '<div class="form-field"><label>cover image</label>' +
            '<input id="f-cover" placeholder="https://… or upload below" value="' + escapeHtml(a.cover_url || '') + '">' +
            '<div class="form-help">paste a URL, or upload a file' + (isEdit ? '' : ' (save first, then upload)') + ':</div>' +
            (isEdit ? '<input id="f-cover-file" type="file" accept="image/*" class="form-help">' : '') +
            '<div class="cover-preview" id="cover-preview">' + (a.cover_url ? '<img src="' + escapeHtml(a.cover_url) + '">' : '<span class="empty">no cover</span>') + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="form-row single">' +
          '<div class="form-field"><label>snippet (short summary)</label><textarea id="f-snippet" style="min-height:50px">' + escapeHtml(a.snippet || '') + '</textarea></div>' +
        '</div>' +
        '<div class="form-row single">' +
          '<div class="form-field"><label>review (blank line separates paragraphs)</label><textarea id="f-body" style="min-height:160px">' + escapeHtml(a.body || '') + '</textarea></div>' +
        '</div>' +
        '<div class="form-row single">' +
          '<div class="form-field"><label>verdict</label><textarea id="f-verdict" style="min-height:50px">' + escapeHtml(a.verdict || '') + '</textarea></div>' +
        '</div>' +
        '<div class="checkbox-row"><input type="checkbox" id="f-draft"' + (a.is_draft ? ' checked' : '') + '><label for="f-draft" style="text-transform:none;letter-spacing:0">save as draft (only you can see it)</label></div>' +
        '<div class="modal-error" id="form-error"></div>' +
        '<div class="form-actions between">' +
          '<div>' + (isEdit ? '<button class="btn danger" id="f-delete">delete</button>' : '') + '</div>' +
          '<div><button class="btn ghost" id="f-cancel">cancel</button> <button class="btn primary" id="f-save">save</button></div>' +
        '</div>' +
      '</div>' +
    '</div>';

  const errEl = root.querySelector('#form-error');

  // live cover preview from URL field
  const coverInput = root.querySelector('#f-cover');
  const preview = root.querySelector('#cover-preview');
  coverInput.oninput = () => {
    const url = coverInput.value.trim();
    preview.innerHTML = url ? '<img src="' + escapeHtml(url) + '" onerror="this.outerHTML=\'<span class=&quot;empty&quot;>bad url</span>\'">' : '<span class="empty">no cover</span>';
  };

  // file upload (edit mode only — needs an album id)
  const fileInput = root.querySelector('#f-cover-file');
  if (fileInput) {
    fileInput.onchange = async () => {
      const file = fileInput.files[0];
      if (!file) return;
      const fd = new FormData();
      fd.append('cover', file);
      errEl.classList.remove('show');
      try {
        const { cover_url } = await api('/albums/' + a.id + '/cover', { method: 'POST', body: fd, isForm: true });
        coverInput.value = cover_url;
        preview.innerHTML = '<img src="' + escapeHtml(cover_url) + '">';
      } catch (e) { errEl.textContent = e.message; errEl.classList.add('show'); }
    };
  }

  const collect = () => ({
    artist: root.querySelector('#f-artist').value,
    title: root.querySelector('#f-title').value,
    year: root.querySelector('#f-year').value,
    genre: root.querySelector('#f-genre').value,
    rating: root.querySelector('#f-rating').value,
    cover_url: root.querySelector('#f-cover').value,
    tags: root.querySelector('#f-tags').value,
    snippet: root.querySelector('#f-snippet').value,
    body: root.querySelector('#f-body').value,
    verdict: root.querySelector('#f-verdict').value,
    is_draft: root.querySelector('#f-draft').checked,
  });

  root.querySelector('#f-save').onclick = async () => {
    errEl.classList.remove('show');
    try {
      let savedId;
      if (isEdit) {
        await api('/albums/' + a.id, { method: 'PUT', body: collect() });
        savedId = a.id;
      } else {
        const { album: created } = await api('/albums', { method: 'POST', body: collect() });
        savedId = created.id;
      }
      await loadAlbums();
      closeModal();
      openSingle(savedId);
    } catch (e) { errEl.textContent = e.message; errEl.classList.add('show'); }
  };

  const delBtn = root.querySelector('#f-delete');
  if (delBtn) delBtn.onclick = () => { closeModal(); confirmDeleteAlbum(a); };

  root.querySelector('#f-cancel').onclick = closeModal;
  root.querySelector('#modal-close').onclick = closeModal;
  root.querySelector('#backdrop').onclick = (e) => { if (e.target.id === 'backdrop') closeModal(); };
}

// ─── 17. confirm delete ──────────────────────────────────────────────────────

function confirmDeleteAlbum(album) {
  if (!confirm('delete "' + album.title + '" by ' + album.artist + '? this cannot be undone.')) return;
  api('/albums/' + album.id, { method: 'DELETE' })
    .then(loadAlbums)
    .then(() => { state.currentSingleId = null; showTab('reviews'); })
    .catch(e => alert(e.message));
}

// ─── 18. init ────────────────────────────────────────────────────────────────

async function init() {
  await loadSession();
  applyAdminClass();
  renderUserWidget();

  try {
    await loadAlbums();
  } catch (e) {
    document.getElementById('page-reviews').innerHTML =
      '<div class="empty-state">could not load albums: ' + escapeHtml(e.message) + '</div>';
    return;
  }

  // tab clicks
  document.querySelectorAll('.tab').forEach(t => {
    t.onclick = () => { if (t.dataset.tab === 'reviews') { /* keep filters */ } showTab(t.dataset.tab); };
  });

  // sidebar nav mirrors the main tabs
  document.querySelectorAll('#sb-nav button').forEach(t => {
    t.onclick = () => showTab(t.dataset.tab);
  });

  // sidebar search → set search state, jump to reviews, filter live
  const sbSearch = document.getElementById('sb-search-input');
  if (sbSearch) {
    sbSearch.oninput = (e) => {
      state.search = e.target.value;
      state.tagFilter = null;
      showTab('reviews');
      // keep focus in the sidebar box and reflect value into the in-page search
      const inPage = document.getElementById('search-input');
      if (inPage) inPage.value = state.search;
    };
  }

  // esc closes modals
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  showTab('reviews');
}

init();
