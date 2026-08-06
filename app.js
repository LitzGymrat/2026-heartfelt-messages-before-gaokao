(function () {
    'use strict';

    const config = window.SUMMER_BRIDGE_CONFIG;
    if (!config || !Array.isArray(config.courses) || config.courses.length === 0) {
        throw new Error('课程配置缺失。');
    }

    const elements = {
        gate: document.getElementById('access-gate'),
        site: document.getElementById('site-shell'),
        accessForm: document.getElementById('access-form'),
        password: document.getElementById('access-password'),
        accessSubmit: document.getElementById('access-submit'),
        accessMessage: document.getElementById('access-message'),
        logoutButton: document.getElementById('logout-button'),
        courseGrid: document.getElementById('course-grid'),
        lessonKicker: document.getElementById('lesson-kicker'),
        lessonTitle: document.getElementById('classroom-title'),
        lessonDescription: document.getElementById('lesson-description'),
        lessonDuration: document.getElementById('lesson-duration'),
        lessonProgress: document.getElementById('lesson-progress'),
        playerFrame: document.getElementById('player-frame'),
        player: document.getElementById('player'),
        playerEmpty: document.getElementById('player-empty'),
        currentCourseName: document.getElementById('current-course-name'),
        currentCourseDot: document.getElementById('current-course-dot'),
        playerStatus: document.getElementById('player-status'),
        resetProgress: document.getElementById('reset-progress'),
    };

    let currentCourse = config.courses[0];
    let accessGranted = false;
    let art = null;
    let lastSavedSecond = -1;
    const signedVideoUrls = new Map();

    function safeStorage(storage, operation, fallback = null) {
        try {
            return operation(storage);
        } catch (_error) {
            return fallback;
        }
    }

    async function fetchJson(url, options) {
        const response = await fetch(url, {
            credentials: 'same-origin',
            ...options,
            headers: {
                ...(options?.body ? { 'Content-Type': 'application/json' } : {}),
                ...(options?.headers || {}),
            },
        });

        if (!response.ok) {
            let detail = '请求失败，请稍后重试。';
            try {
                const payload = await response.json();
                detail = payload.error || detail;
            } catch (_error) {
                detail = await response.text() || detail;
            }
            const error = new Error(detail);
            error.status = response.status;
            throw error;
        }

        if (response.status === 204) return null;
        return response.json();
    }

    function progressKey(courseId) {
        return `${config.storagePrefix}:progress:${courseId}`;
    }

    function readProgress(courseId) {
        const raw = safeStorage(window.localStorage, (storage) => storage.getItem(progressKey(courseId)), '0');
        const seconds = Number(raw);
        return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    }

    function writeProgress(courseId, seconds) {
        if (!Number.isFinite(seconds) || seconds < 0) return;
        safeStorage(window.localStorage, (storage) => storage.setItem(progressKey(courseId), String(Math.floor(seconds))));
    }

    function formatProgress(seconds) {
        if (!seconds) return '尚未开始';
        const minutes = Math.floor(seconds / 60);
        const remainder = Math.floor(seconds % 60);
        return `上次看到 ${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
    }

    function createCourseCard(course) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'course-card';
        button.dataset.courseId = course.id;
        button.style.setProperty('--course-accent', course.accent);
        button.setAttribute('aria-pressed', 'false');
        button.innerHTML = `
            <span class="card-topline"><b>${course.sequence}</b><em>${course.duration}</em></span>
            <span class="card-symbol" aria-hidden="true">${course.shortName}</span>
            <span class="card-copy">
                <small>${course.englishName}</small>
                <strong>${course.subject}衔接课</strong>
                <span>${course.description}</span>
            </span>
            <span class="card-action">进入课程 <i aria-hidden="true">↗</i></span>
        `;
        button.addEventListener('click', () => void selectCourse(course.id, true));
        return button;
    }

    function renderCourseCards() {
        const fragment = document.createDocumentFragment();
        config.courses.forEach((course) => fragment.appendChild(createCourseCard(course)));
        elements.courseGrid.replaceChildren(fragment);
    }

    function saveCurrentProgress() {
        if (!art || !currentCourse) return;
        const seconds = Number(art.currentTime || art.video?.currentTime || 0);
        writeProgress(currentCourse.id, seconds);
    }

    function destroyPlayer(saveProgress = true) {
        if (art) {
            if (saveProgress) saveCurrentProgress();
            art.destroy(true);
            art = null;
        }
        elements.player.replaceChildren();
    }

    function setEmptyState(title, description, status) {
        elements.playerEmpty.hidden = false;
        elements.playerEmpty.querySelector('strong').textContent = title;
        elements.playerEmpty.querySelector('p').textContent = description;
        elements.playerStatus.textContent = status;
    }

    function updateCourseCardStates(courseId) {
        document.querySelectorAll('.course-card').forEach((card) => {
            const active = card.dataset.courseId === courseId;
            card.classList.toggle('is-active', active);
            card.setAttribute('aria-pressed', String(active));
        });
    }

    function updateLessonCopy(course) {
        elements.lessonKicker.textContent = `${course.englishName} · ${course.sequence}`;
        elements.lessonTitle.replaceChildren(...course.displayTitle.split('\n').map((line) => {
            const span = document.createElement('span');
            span.textContent = line;
            return span;
        }));
        elements.lessonDescription.textContent = course.description;
        elements.lessonDuration.textContent = course.duration;
        elements.lessonProgress.textContent = formatProgress(readProgress(course.id));
        elements.currentCourseName.textContent = `${course.subject}衔接课`;
        elements.currentCourseDot.style.backgroundColor = course.accent;
        elements.playerFrame.dataset.theme = course.id;
        elements.playerFrame.style.setProperty('--active-accent', course.accent);
        elements.playerEmpty.querySelector('.empty-subject').textContent = course.shortName;
    }

    async function getSignedVideoUrl(course) {
        const cached = signedVideoUrls.get(course.id);
        if (cached && cached.expiresAt > Date.now()) return cached.url;

        const payload = await fetchJson(`/api/video-url?course=${encodeURIComponent(course.id)}`);
        const safetyWindowSeconds = Math.min(120, Math.max(15, payload.expiresInSeconds / 10));
        signedVideoUrls.set(course.id, {
            url: payload.url,
            expiresAt: Date.now() + Math.max(0, payload.expiresInSeconds - safetyWindowSeconds) * 1000,
        });
        return payload.url;
    }

    function createPlayer(course, url) {
        if (typeof window.Artplayer !== 'function') {
            setEmptyState('播放器加载失败', '请检查网络后刷新页面。', '播放器组件未加载');
            return;
        }

        elements.playerEmpty.hidden = true;
        elements.playerStatus.textContent = '正在准备课程';
        const resumeAt = readProgress(course.id);

        art = new window.Artplayer({
            container: elements.player,
            url,
            poster: course.poster || undefined,
            type: 'mp4',
            autoplay: false,
            autoSize: false,
            pip: true,
            fullscreen: true,
            fullscreenWeb: true,
            playbackRate: true,
            setting: true,
            mutex: true,
            theme: course.accent,
            volume: 0.85,
            moreVideoAttr: {
                preload: 'metadata',
                playsinline: 'true',
                'webkit-playsinline': 'true',
            },
        });

        art.on('ready', () => {
            if (resumeAt > 10 && art.duration && resumeAt < art.duration - 10) {
                art.currentTime = resumeAt;
                elements.playerStatus.textContent = `已续播至 ${formatProgress(resumeAt).replace('上次看到 ', '')}`;
            } else {
                elements.playerStatus.textContent = '课程已就绪';
            }
        });

        art.on('video:timeupdate', () => {
            const currentSecond = Math.floor(Number(art.currentTime || 0));
            if (currentSecond >= 0 && currentSecond !== lastSavedSecond && currentSecond % 5 === 0) {
                lastSavedSecond = currentSecond;
                writeProgress(course.id, currentSecond);
                elements.lessonProgress.textContent = formatProgress(currentSecond);
            }
        });

        art.on('video:error', () => {
            elements.playerStatus.textContent = '视频加载失败，请稍后重试';
        });
    }

    function showGate(message = '') {
        accessGranted = false;
        signedVideoUrls.clear();
        destroyPlayer();
        elements.site.hidden = true;
        elements.gate.hidden = false;
        elements.gate.classList.remove('is-leaving');
        elements.accessMessage.textContent = message;
        document.body.classList.remove('site-ready');
        window.setTimeout(() => elements.password.focus(), 0);
    }

    function revealSite() {
        accessGranted = true;
        elements.site.hidden = false;
        elements.gate.classList.add('is-leaving');
        window.setTimeout(() => {
            elements.gate.hidden = true;
            document.body.classList.add('site-ready');
        }, 460);
    }

    async function loadCourseVideo(course) {
        setEmptyState('正在获取课程', '服务器正在生成本次播放所需的临时地址。', '正在验证播放权限');
        try {
            const url = await getSignedVideoUrl(course);
            if (course.id !== currentCourse.id) return;
            createPlayer(course, url);
        } catch (error) {
            if (error.status === 403) {
                showGate('访问已过期，请重新输入密码。');
                return;
            }
            setEmptyState('课程暂时无法播放', error.message, '视频地址获取失败');
        }
    }

    async function selectCourse(courseId, scrollToPlayer) {
        const nextCourse = config.courses.find((course) => course.id === courseId);
        if (!nextCourse) return;

        destroyPlayer();
        currentCourse = nextCourse;
        lastSavedSecond = -1;
        updateCourseCardStates(courseId);
        updateLessonCopy(nextCourse);

        if (accessGranted) {
            await loadCourseVideo(nextCourse);
        } else {
            setEmptyState('课程视频受保护', '输入访问密码后，服务器会生成本次播放所需的临时地址。', '等待访问验证');
        }

        if (scrollToPlayer) {
            document.getElementById('classroom').scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    elements.accessForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        elements.accessSubmit.disabled = true;
        elements.accessMessage.textContent = '';
        try {
            await fetchJson('/api/access', {
                method: 'POST',
                body: JSON.stringify({ password: elements.password.value }),
            });
            elements.password.value = '';
            revealSite();
            await selectCourse(currentCourse.id, false);
        } catch (error) {
            elements.accessMessage.textContent = error.message;
            elements.password.select();
        } finally {
            elements.accessSubmit.disabled = false;
        }
    });

    elements.logoutButton.addEventListener('click', async () => {
        try {
            await fetchJson('/api/logout', { method: 'POST' });
        } finally {
            showGate('已安全退出。');
        }
    });

    elements.resetProgress.addEventListener('click', () => {
        config.courses.forEach((course) => safeStorage(window.localStorage, (storage) => storage.removeItem(progressKey(course.id))));
        elements.lessonProgress.textContent = '尚未开始';
        elements.playerStatus.textContent = art ? '本机进度已清除' : '等待课程播放';
    });

    window.addEventListener('beforeunload', saveCurrentProgress);

    async function restoreSession() {
        try {
            const session = await fetchJson('/api/session');
            if (!session.accessGranted) {
                elements.password.focus();
                return;
            }
            revealSite();
            await selectCourse(currentCourse.id, false);
        } catch (error) {
            elements.accessMessage.textContent = error.message;
        }
    }

    renderCourseCards();
    void selectCourse(config.courses[0].id, false);
    void restoreSession();
}());
