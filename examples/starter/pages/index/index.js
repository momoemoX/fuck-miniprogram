Page({
  data: {
    title: 'Pure Web Mini Program Engine',
    count: 0
  },
  increment() {
    this.setData({ count: this.data.count + 1 });
  }
});
