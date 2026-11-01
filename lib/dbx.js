// Dropbox 요청을 담당하는 층. 카카시와 같은 사이트에 있으므로 카카시의 로그인 정보(kakashi.dbx)를 함께 쓴다.
const Dbx = {
  key: 'r5x3zw22oc0ovgt', // Dropbox 앱의 App key (비밀값이 아니다)
  defaultKakashiPath: '/SBSA/KAKASHI',
  CHUNK: 8 * 1024 * 1024,
  SIMPLE_UPLOAD_MAX: 100 * 1024 * 1024,
  access: null, accessUntil: 0,

  conf() { try { return JSON.parse(localStorage.getItem('kakashi.dbx') || 'null'); } catch { return null; } },
  setConf(c) { try { localStorage.setItem('kakashi.dbx', JSON.stringify(c)); } catch {} },
  // 앱 폴더는 카카시 폴더 옆에 둔다
  base() { return this.conf().path.replace(/[^/]+$/, 'NOKCHWI'); },

  /* ---------- 로그인: 화면에 나온 코드를 붙여넣는 방식 ----------
     주소 되돌리기(redirect) 방식은 아이폰 홈 화면 앱에서 저장 공간이 달라 실패하므로 쓰지 않는다 */
  async startLogin() {
    const rand = crypto.getRandomValues(new Uint8Array(48));
    const b64 = b => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const verifier = b64(rand);
    localStorage.setItem('nokchwi.dbxVerifier', verifier);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    return 'https://www.dropbox.com/oauth2/authorize?' + new URLSearchParams({
      client_id: this.key, response_type: 'code', token_access_type: 'offline',
      code_challenge: b64(hash), code_challenge_method: 'S256',
      scope: 'files.metadata.read files.content.read files.content.write',
    });
  },
  async token(params) {
    const r = await this.net('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST', body: new URLSearchParams({ client_id: this.key, ...params }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error_description || d.error || '인증 실패');
    this.access = d.access_token;
    this.accessUntil = Date.now() + (d.expires_in - 60) * 1000;
    return d;
  },
  async finishLogin(code) {
    const d = await this.token({
      grant_type: 'authorization_code', code: code.trim(),
      code_verifier: localStorage.getItem('nokchwi.dbxVerifier') || '',
    });
    this.setConf({ refresh: d.refresh_token, path: this.defaultKakashiPath });
    localStorage.removeItem('nokchwi.dbxVerifier');
  },

  /* ---------- 요청 ---------- */
  async net(url, opts) {
    try { return await fetch(url, opts); }
    catch { throw new Error('인터넷 연결을 확인하세요'); }
  },
  async bearer(force) {
    if (force || !this.access || Date.now() > this.accessUntil) {
      const c = this.conf();
      if (!c) throw new Error('Dropbox가 연결되어 있지 않습니다');
      await this.token({ grant_type: 'refresh_token', refresh_token: c.refresh });
    }
    return this.access;
  },
  async api(url, opts, retried) {
    const r = await this.net(url, { ...opts, headers: { ...opts.headers, Authorization: 'Bearer ' + await this.bearer(retried === 401) } });
    if (r.status === 401 && !retried) return this.api(url, opts, 401);
    if (r.status === 429 && retried !== 429) {
      const wait = +r.headers.get('Retry-After') || 2;
      await new Promise(res => setTimeout(res, wait * 1000));
      return this.api(url, opts, 429);
    }
    if (!r.ok) {
      const text = await r.text();
      let summary = text;
      try { summary = JSON.parse(text).error_summary || text; } catch {}
      const err = new Error('Dropbox 오류: ' + summary);
      err.summary = summary;
      throw err;
    }
    return r;
  },
  rpc(name, arg) {
    return this.api('https://api.dropboxapi.com/2/' + name, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(arg),
    }).then(r => r.json());
  },
  content(name, arg, body) {
    return this.api('https://content.dropboxapi.com/2/' + name, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': this.argHeader(arg) },
      body,
    });
  },
  // Dropbox-API-Arg 헤더에는 한글을 그대로 넣을 수 없다
  argHeader(arg) {
    return JSON.stringify(arg).replace(/[\u007f-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  },

  /* ---------- 폴더와 파일 ---------- */
  async list(path) {
    let page = await this.rpc('files/list_folder', { path });
    let out = page.entries;
    while (page.has_more) {
      page = await this.rpc('files/list_folder/continue', { cursor: page.cursor });
      out = out.concat(page.entries);
    }
    return out;
  },
  async ensureFolder(path) {
    try { await this.rpc('files/create_folder_v2', { path, autorename: false }); }
    catch (e) { if (!/path\/conflict/.test(e.summary || '')) throw e; }
  },
  async download(path, type) {
    const r = await this.content('files/download', { path });
    // 아이폰은 형식이 지정되지 않은 파일을 재생하지 못한다
    return new Blob([await r.blob()], { type: type || 'application/octet-stream' });
  },
  // mode가 'add'면 같은 이름이 있어도 지우지 않고 새 이름으로 올린다
  async upload(path, blob, mode, onProgress) {
    const commit = { path, mode, autorename: mode === 'add', mute: true };
    if (blob.size <= this.SIMPLE_UPLOAD_MAX) {
      return (await this.content('files/upload', commit, blob)).json();
    }
    const start = await (await this.content('files/upload_session/start', { close: false }, new Blob([]))).json();
    let offset = 0;
    for (; offset + this.CHUNK < blob.size; offset += this.CHUNK) {
      await this.content('files/upload_session/append_v2', { cursor: { session_id: start.session_id, offset } }, blob.slice(offset, offset + this.CHUNK));
      onProgress?.(offset / blob.size);
    }
    const r = await this.content('files/upload_session/finish', { cursor: { session_id: start.session_id, offset }, commit }, blob.slice(offset));
    return r.json();
  },
};
const dbxKey = s => s.normalize('NFC').toLowerCase();
