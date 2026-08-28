// 前端课程名称、颜色与显示开关；视频对象由服务端配置。
window.SUMMER_BRIDGE_CONFIG = Object.freeze({
    storagePrefix: 'gaoyi-summer-transition-2026',
    courses: [
        {
            id: 'chinese',
            subject: '语文',
            shortName: '语',
            accent: '#3370ff',
            poster: '',
        },
        {
            id: 'math',
            subject: '数学',
            shortName: '数',
            accent: '#1456f0',
            poster: '',
        },
        {
            id: 'english',
            subject: '英语',
            shortName: '英',
            accent: '#2f88ff',
            poster: '',
            hidden: false,
        },
        {
            id: 'physics',
            subject: '物理',
            shortName: '物',
            accent: '#5b67d6',
            poster: '',
            hidden: false,
        },
    ],
});
