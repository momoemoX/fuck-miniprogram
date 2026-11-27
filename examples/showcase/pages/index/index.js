Page({
  data: {
    visits: 1,
    count: 3,
    note: 'Hello Pure Web Mini Program',
    progress: 68,
    darkCard: false,
    features: [
      { id: 'wxml', name: 'WXML/WXSS/WXS 静态编译', tag: 'Zero VDOM' },
      { id: 'model', name: 'model: 简易双向绑定', tag: 'P0' },
      { id: 'wxs', name: 'WXS change:prop 视图响应', tag: 'P0' },
      { id: 'anim', name: '滚动驱动关键帧 + Canvas 2D', tag: 'P1' }
    ]
  },

  onLoad() {
    const app = getApp();
    this.setData({ visits: app.globalData.visits });
  },

  onSliderChange(e) {
    this.setData({ progress: Number(e.detail.value) });
  },

  onSwitchChange(e) {
    this.setData({ darkCard: !!e.detail.value });
  },

  onShowToast() {
    wx.showToast({
      title: `当前计数 ${this.data.count}`,
      icon: 'success',
      duration: 1500
    });
  },

  onShowModal() {
    wx.showModal({
      title: 'FMP 基础库',
      content: `纯 Web 运行时 · 第 ${this.data.visits} 次访问 · 当前进度 ${this.data.progress}%`,
      showCancel: false
    });
  },

  onOpenLab() {
    wx.navigateTo({
      url: `/pages/lab/index?count=${this.data.count}&note=${encodeURIComponent(this.data.note)}`
    });
  }
});
