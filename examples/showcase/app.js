App({
  globalData: {
    engine: '@fuck-miniprogram/engine',
    visits: 1
  },
  onLaunch() {
    const saved = wx.getStorageSync('fmp_showcase_visits');
    const next = (Number(saved) || 0) + 1;
    this.globalData.visits = next;
    wx.setStorageSync('fmp_showcase_visits', next);
  }
});
