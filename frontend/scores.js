/* Each run owns its submission, independent of later games. No gameplay rules here. */
(function (root) {
  class ScoreClient {
    constructor(apiBase, onStatus = () => {}) {
      this.apiBase = apiBase;
      this.onStatus = onStatus;
      this.storageKey = `airplane.pending.v1:${apiBase}`;
      this.pending = [];
      this.flushing = false;
      this.waiting = 0;
      this.storageAvailable = false;
      try {
        this.storageAvailable = Boolean(root.localStorage);
        const saved = JSON.parse(root.localStorage?.getItem(this.storageKey) || "[]");
        if (Array.isArray(saved)) this.pending = saved.filter(item => item &&
          typeof item.runId === 'string' && typeof item.token === 'string' &&
          Number.isSafeInteger(item.score) && Number.isSafeInteger(item.durationMs));
      } catch { /* Storage may be unavailable; in-memory retry still works. */ }
    }
    persist() {
      try {
        if (!root.localStorage) throw new Error('storage unavailable');
        root.localStorage.setItem(this.storageKey, JSON.stringify(this.pending));
        this.storageAvailable = true;
      } catch {
        this.storageAvailable = false;
        this.onStatus('无法保存待提交成绩到此浏览器；请在关闭页面前重试');
      }
    }
    async request(path, options = {}) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      try {
        const response = await fetch(`${this.apiBase}${path}`, { ...options, signal: controller.signal });
        if (!response.ok) {
          const error = new Error(`HTTP ${response.status}`);
          error.status = response.status;
          throw error;
        }
        return await response.json();
      } finally { clearTimeout(timer); }
    }
    begin() {
      const run = { credentials: null, ready: null };
      run.ready = this.request('/runs', { method: 'POST' }).then((credentials) => {
        run.credentials = credentials;
      }).catch(() => {
        this.onStatus('排行榜不可用，本局仍可游玩；本局不会上榜');
      });
      return run;
    }
    async finish(run, score, durationMs) {
      if (!run || score <= 0) return;
      this.waiting++;
      this.onStatus(`正在准备提交本局 ${score} 分…`);
      try { await run.ready; } finally { this.waiting--; }
      if (!run.credentials) {
        this.onStatus(`本局 ${score} 分未同步：开始时未取得对局凭证`);
        return;
      }
      this.pending.push({ ...run.credentials, score, durationMs: Math.floor(durationMs) });
      this.persist();
      await this.flush();
    }
    async flush() {
      if (this.flushing || !this.pending.length) return;
      this.flushing = true;
      let failed = false;
      let rejected = 0;
      try {
        // Failed runs do not prevent later queued games from being attempted.
        for (const item of [...this.pending]) {
          try {
            await this.request('/leaderboard', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(item),
            });
            this.pending.splice(this.pending.indexOf(item), 1);
          } catch (error) {
            if ([400, 403, 409, 410, 422].includes(error.status)) {
              this.pending.splice(this.pending.indexOf(item), 1);
              rejected++;
            } else { failed = true; }
          }
        }
        this.persist();
        if (this.pending.length) this.onStatus(`还有 ${this.pending.length} 局未同步，请重试${this.storageAvailable ? "" : "；浏览器存储不可用，关闭页面会丢失"}`);
        else if (rejected) this.onStatus(`${rejected} 局未通过校验或凭证已过期，未上榜`);
        else this.onStatus('成绩已同步（娱乐榜，非完整反作弊验证）');
      } finally {
        this.flushing = false;
        // A new game can finish while an earlier POST is awaiting its response.
        if (!failed && this.pending.length) void this.flush();
      }
    }
  }
  root.ScoreClient = ScoreClient;
  if (typeof module !== 'undefined') module.exports = { ScoreClient };
})(typeof window === 'undefined' ? globalThis : window);
