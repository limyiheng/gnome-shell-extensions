import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import Meta from 'gi://Meta';

import {Extension as _Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import { AppSwitcherPopup } from 'resource:///org/gnome/shell/ui/altTab.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as SwipeTracker from 'resource:///org/gnome/shell/ui/swipeTracker.js';

const RESPONSE_THRESHOLD = 150;
const endLeft = 0;
const endUP = 1;

const APPSWITCH_PROGRESS_SCALE = 1 - 1e-16;

function getWindow() {
    let [x, y] = global.get_pointer();
    let actor = global.stage.get_actor_at_pos(Clutter.PickMode.ALL, x, y);
    let window = actor.get_parent().get_parent().metaWindow;
    if (window != null) {
       Main.activateWindow(window);
       return window;
    } else {
       return global.display.focus_window;
    }
}

function moveWindowWorkspace(moveToLeft) {
    const window = getWindow();
    if (window == null)
        return;

    Main.wm._showWorkspaceSwitcher(global.display, window, {}, {
        get_name: () => 'move-to-workspace-' + (moveToLeft ? 'left' : 'right')
    });
}

function maximizeWindow(maximize) {
    const window = getWindow();
    if (window == null)
        return;

    if (maximize == null || maximize) {
        if (window.is_fullscreen())
            window.unmake_fullscreen();
        else if (window.get_maximized())
            window.make_fullscreen();
        else
            window.maximize(Meta.MaximizeFlags.BOTH);
    } else {
        if (window.is_fullscreen())
            window.unmake_fullscreen();
        else if (window.get_maximized())
            window.unmaximize(Meta.MaximizeFlags.BOTH);
        else
            window.minimize();
    }
}

function makeWindowAbove(above) {
    const window = getWindow();
    if (window == null)
        return;

    if (above)
        window.make_above();
    else
        window.unmake_above();
}

function setSwipeFingerCount(tracker, count) {
    const g = tracker._touchpadGesture;
    g._event = (actor, event) => {
        const finger_count = event.get_touchpad_gesture_finger_count();
        event.get_touchpad_gesture_finger_count = () => {
            return finger_count == count ? 3 : 0;
        };
        return g._handleEvent(actor, event);
    };
    global.stage.disconnectObject(g);
    global.stage.connectObject(
        'captured-event::touchpad',
        g._event.bind(g),
        g
    );
}

class appSwitch {
    _gestureBegin() {
        this._popup = new AppSwitcherPopup();
        this._popup._resetNoModsTimeout = () => undefined;
        this._selectedWindow = undefined;

        if (!this._popup.show(false, 'switch-applications', 0)) {
            this._popup.destroy();
            this._popup = undefined;
        } else {
            this._popup._popModal();
        }
    }

    _gestureUpdate(tracker, progress) {
        if (this._popup) {
            const popup = this._popup;
            const appsLength = popup._items.length;
            const _index = 2*appsLength*APPSWITCH_PROGRESS_SCALE*(1-progress);
            const index = Math.floor(_index);
            const appIndex = index % appsLength;
            const cachedWindows = popup._items[appIndex].cachedWindows;
            const windowsLength = cachedWindows.length;
            const windowIndex = Math.floor((_index - index)*windowsLength);

            this._selectedWindow = cachedWindows[windowIndex];

            if (popup._selectedIndex !== appIndex)
                if (popup._thumbnails) {
                    popup._thumbnails.destroy();
                    popup._thumbnails = null;
                }

            popup._selectedIndex = appIndex;
            popup._switcherList.highlight(appIndex, false);
            if (windowsLength != 1) {
                if (!popup._thumbnails)
                    popup._createThumbnails();
                popup._thumbnails.highlight(windowIndex, false);
            }
        }
    }

    _gestureEnd() {
        if (this._popup) {
            if (this._selectedWindow)
                Main.activateWindow(this._selectedWindow);
            this._popup.destroy();
        }
    }
}


export default class Extension extends _Extension {
    _gestureBegin(tracker, monitor) {
        this._startTime = new Date();
        this._longSwipe = false;
        this._gestureBeginUpdate = true;
        this._gestureInitialProgress = 0;
        this._gestureEndProgress = undefined;
        tracker.confirmSwipe(0, [0, 1], 0.5, 0.5);
    }

    _gestureUpdate(tracker, progress) {
        if (this._longSwipe) {
            if (tracker.orientation == Clutter.Orientation.HORIZONTAL) {
                if (!Main.overview.visible) {
                    if (this._gestureBeginUpdate) {
                        this._appSwitch._gestureBegin();
                    } else {
                        this._appSwitch._gestureUpdate(tracker, progress);
                    }
                }
            } else {
                if (this._gestureBeginUpdate &&
                    (Main.overview.visible || progress < 0.5)) {
                    Main.overview._gestureBegin({
                        confirmSwipe: (distance, snapPoints, currentProgress, cancelProgress) => {
                            this._gestureInitialProgress = currentProgress;
                            this._gestureEndProgress = cancelProgress;
                        }});
                } else if (this._gestureEndProgress !== undefined) {
                    let mappedProgress = this._gestureInitialProgress + 1 - 2*progress;
                    Main.overview._gestureUpdate(tracker, mappedProgress);
                }
            }
            this._gestureBeginUpdate = false
        } else
            this._longSwipe = new Date() - this._startTime > RESPONSE_THRESHOLD;
    }

    _gestureEnd(tracker, duration, endProgress) {
        if (tracker.orientation == Clutter.Orientation.HORIZONTAL) {
            if (this._longSwipe) {
                this._appSwitch._gestureEnd();
            } else {
                moveWindowWorkspace(endProgress != endLeft)
            }
        } else {
           if (this._gestureEndProgress !== undefined) {
                let progress = this._gestureInitialProgress + 1 - 2*endProgress;
                Main.overview._gestureEnd(tracker, duration, progress);
            } else if (this._longSwipe) {
                makeWindowAbove(endProgress == endUP);
            } else
                maximizeWindow(endProgress == endUP);
        }
    }


    enable() {
        this._appSwitch = new appSwitch();
        this._swipeTrackers = [
            Clutter.Orientation.HORIZONTAL,
            Clutter.Orientation.VERTICAL
        ].map(orientation => {
            const swipeTracker = new SwipeTracker.SwipeTracker(global.stage,
                orientation,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                { allowDrag: false, allowScroll: false });
            setSwipeFingerCount(swipeTracker, 3);

            swipeTracker._gestureIds = [
                swipeTracker.connect('begin', this._gestureBegin.bind(this)),
                swipeTracker.connect('update', this._gestureUpdate.bind(this)),
                swipeTracker.connect('end', this._gestureEnd.bind(this))
            ];
            return swipeTracker;
        });


        this._touchpadGesture4 = [
            Main.wm._workspaceAnimation._swipeTracker,
            Main.overview._overview._controls._workspacesDisplay._swipeTracker
        ];
        this._disabledTouchpadGesture = [
            Main.overview._swipeTracker,
        ];


        this._disabledTouchpadGesture.forEach(tracker => {
            global.stage.disconnectObject(tracker._touchpadGesture);
        });

        this._touchpadGesture4.forEach(tracker => setSwipeFingerCount(tracker ,4));
        /*{
            const g = tracker._touchpadGesture;
            g._event = (actor, event) => {
                event._finger_count = event.get_touchpad_gesture_finger_count;
                event.get_touchpad_gesture_finger_count = () => {
                    return event._finger_count() == 4 ? 3 : 0;
                };
                return g._handleEvent(actor, event);
            };
            global.stage.disconnectObject(g);
            global.stage.connectObject(
                'captured-event::touchpad',
                g._event.bind(g),
                g
            );
        });*/

        console.log(`Enabled ${this.uuid}`);
    }

    disable() {
        this._swipeTrackers.forEach(tracker => {
            tracker.disconnect('begin', tracker._gestureIds[0]);
            tracker.disconnect('update', tracker._gestureIds[1]);
            tracker.disconnect('end', tracker._gestureIds[2]);
        });
        this._appSwitch = undefined;
        this._swipeTrackers = undefined;


        this._disabledTouchpadGesture.forEach(tracker => {
            const g = tracker._touchpadGesture;
            global.stage.connectObject(
                'captured-event::touchpad',
                g._handleEvent.bind(g),
                g
            );
        });

        this._touchpadGesture4.forEach(tracker => {
            const g = tracker._touchpadGesture;
            global.stage.disconnectObject(g);
            global.stage.connectObject(
                'captured-event::touchpad',
                g._handleEvent.bind(g),
                g
            );
        });


        this._touchpadGesture4 = undefined;
        this._disabledTouchpadGesture = undefined;

        console.log(`Disabled ${this.uuid}`);
    }
}

