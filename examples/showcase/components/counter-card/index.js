Component({
  options: {
    styleIsolation: 'isolated'
  },
  externalClasses: ['accent-class'],
  properties: {
    count: {
      type: Number,
      value: 0
    },
    label: {
      type: String,
      value: '双向绑定计数'
    }
  },
  methods: {
    dec() {
      this.setData({ count: Math.max(0, this.properties.count - 1) });
      this.triggerEvent('change', { count: this.data.count });
    },
    inc() {
      this.setData({ count: this.properties.count + 1 });
      this.triggerEvent('change', { count: this.data.count });
    }
  }
});
