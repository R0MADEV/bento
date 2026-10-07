//! Keeps the main window inside the screen it is on.
//!
//! With decorations off the window is borderless, and macOS neither constrains a
//! borderless window to the screen nor gives it a title bar to drag. When a
//! display is plugged in or removed the window can end up bigger than its new
//! screen, with its edges out of reach, so it can't be resized or moved back.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// The frame the window should take to fit inside `area`, or `None` when it
/// already fits. It shrinks first, then shifts as little as possible.
pub fn fit_rect(window: Rect, area: Rect) -> Option<Rect> {
    let width = window.width.min(area.width);
    let height = window.height.min(area.height);
    let x = window.x.clamp(area.x, area.x + area.width - width);
    let y = window.y.clamp(area.y, area.y + area.height - height);
    let fitted = Rect { x, y, width, height };
    (fitted != window).then_some(fitted)
}

/// Shrinks and moves the window into the work area of its screen (or the main
/// one, when it is off every screen) if it doesn't fit there any more.
pub fn keep_on_screen(window: &tauri::WebviewWindow) {
    let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return;
    };
    let monitor = window.current_monitor().ok().flatten().or_else(|| window.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return;
    };
    let work_area = monitor.work_area();
    let current = Rect { x: position.x, y: position.y, width: to_i32(size.width), height: to_i32(size.height) };
    let area = Rect {
        x: work_area.position.x,
        y: work_area.position.y,
        width: to_i32(work_area.size.width),
        height: to_i32(work_area.size.height),
    };
    let Some(fitted) = fit_rect(current, area) else {
        return;
    };
    let _ = window.set_size(tauri::PhysicalSize::new(fitted.width, fitted.height));
    let _ = window.set_position(tauri::PhysicalPosition::new(fitted.x, fitted.y));
}

fn to_i32(value: u32) -> i32 {
    i32::try_from(value).unwrap_or(i32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: Rect = Rect { x: 0, y: 0, width: 1920, height: 1080 };

    #[test]
    fn leaves_a_window_that_already_fits() {
        let window = Rect { x: 100, y: 100, width: 800, height: 600 };
        assert_eq!(fit_rect(window, SCREEN), None);
    }

    #[test]
    fn shrinks_a_window_bigger_than_the_screen() {
        let window = Rect { x: 0, y: 0, width: 3456, height: 2234 };
        assert_eq!(fit_rect(window, SCREEN), Some(SCREEN));
    }

    #[test]
    fn pulls_back_a_window_hanging_off_the_bottom_right() {
        let window = Rect { x: 1500, y: 900, width: 800, height: 600 };
        let fitted = Rect { x: 1120, y: 480, width: 800, height: 600 };
        assert_eq!(fit_rect(window, SCREEN), Some(fitted));
    }

    #[test]
    fn pulls_back_a_window_hanging_off_the_top_left() {
        let window = Rect { x: -200, y: -50, width: 800, height: 600 };
        let fitted = Rect { x: 0, y: 0, width: 800, height: 600 };
        assert_eq!(fit_rect(window, SCREEN), Some(fitted));
    }

    // A second display sits at an offset in the global space (here to the left).
    #[test]
    fn fits_inside_a_screen_with_an_offset_origin() {
        let left_screen = Rect { x: -2560, y: 25, width: 2560, height: 1415 };
        let window = Rect { x: -2000, y: 0, width: 3000, height: 1600 };
        assert_eq!(fit_rect(window, left_screen), Some(left_screen));
    }
}
