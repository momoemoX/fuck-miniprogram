Page({
  data: {
    fromCount: '0',
    fromNote: '',
    cacheResult: '点击按钮测试 CacheManager 规则匹配'
  },

  onLoad(options) {
    this.setData({
      fromCount: options.count || '0',
      fromNote: options.note ? decodeURIComponent(options.note) : ''
    });
  },

  onReady() {
    this.animate(
      '#scroll-bar',
      [
        { width: '60px', backgroundColor: '#3b82f6' },
        { width: '260px', backgroundColor: '#07c160' }
      ],
      200,
      {
        scrollSource: '#demo-scroll',
        timeRange: 200,
        startScrollOffset: 0,
        endScrollOffset: 160
      }
    );
    this.drawCanvas();
  },

  drawCanvas() {
    this.createSelectorQuery()
      .select('#lab-canvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        const entry = res && res[0];
        if (!entry || !entry.node) return;
        const canvas = entry.node;
        const ctx = canvas.getContext('2d');
        const w = 280;
        const h = 110;
        canvas.width = w;
        canvas.height = h;
        const grad = ctx.createLinearGradient(0, 0, w, h);
        grad.addColorStop(0, '#07c160');
        grad.addColorStop(1, '#2563eb');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = 'rgba(255,255,255,0.22)';
        const p = canvas.createPath2D();
        p.arc(230, 55, 36, 0, Math.PI * 2);
        ctx.fill(p);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 18px sans-serif';
        ctx.fillText('Canvas 2D + Path2D', 18, 48);
        ctx.font = '13px sans-serif';
        ctx.fillText('Rendered natively in Web Canvas', 18, 74);
      });
  },

  onTestCache() {
    const cm = wx.createCacheManager({ origin: 'https://api.example.com', mode: 'weakNetwork' });
    const id = cm.addRule('GET /items/:id');
    const hit = cm.match({ url: 'https://api.example.com/items/42', method: 'GET' });
    const miss = cm.match({ url: 'https://api.example.com/other', method: 'GET' });
    cm.deleteRule(id);
    this.setData({
      cacheResult: `规则 ${id}：/items/42 → ${hit ? 'HIT' : 'MISS'}，/other → ${miss ? 'HIT' : 'MISS'}`
    });
  },

  onBack() {
    wx.navigateBack();
  }
});
