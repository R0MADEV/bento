//! Full-screen panel mode: a navigable list of terminals/agents, with
//! inline attach (returns to the list when the remote session ends), plus a
//! Review tab for running AI code reviews without leaving the terminal.

mod drawer;
mod pane;
mod review;
mod screen;
mod sidebar;
mod terminals;

use crossterm::event::{
    DisableMouseCapture, EnableMouseCapture, Event, EventStream, KeyCode, KeyEventKind, MouseButton,
    MouseEventKind,
};
use crossterm::execute;
use tokio_stream::StreamExt;

use review::ReviewState;

/// The live pty and the grid its bytes are painted into. Boxed inside `Mode`
/// because it dwarfs the other variants, which would otherwise pay its size.
struct Attached {
    session: terminals::Session,
    screen: screen::Screen,
}

enum Mode {
    List,
    Attached(Box<Attached>),
    Review,
}

pub async fn run() -> std::io::Result<()> {
    let mut terminal = ratatui::try_init()?;
    // Dragging the rail's divider needs mouse events. It is turned off again
    // while attached, so the remote program keeps its own mouse handling.
    let _ = execute!(std::io::stdout(), EnableMouseCapture);
    let result = run_app(&mut terminal).await;
    let _ = execute!(std::io::stdout(), DisableMouseCapture);
    ratatui::try_restore()?;
    result
}

async fn run_app(terminal: &mut ratatui::DefaultTerminal) -> std::io::Result<()> {
    let mut events = EventStream::new();
    let mut mode = Mode::List;
    let mut items = terminals::fetch_terminals().await.unwrap_or_default();
    let mut selected: usize = 0;
    let mut refresh = tokio::time::interval(std::time::Duration::from_secs(2));
    let cwd = std::env::current_dir().map(|p| p.display().to_string()).unwrap_or_default();
    let mut review = ReviewState::new(cwd.clone());
    let mut sidebar_width = sidebar::DEFAULT_WIDTH;
    // The width to come back to, so unfolding returns the rail the user had
    // sized rather than the default.
    let mut restored_width = sidebar::DEFAULT_WIDTH;
    let mut dragging_divider = false;
    // The review drawer's edge, dragged separately from the rail's.
    let mut dragging_drawer = false;
    let mut status = String::new();

    loop {
        match &mut mode {
            Mode::List => {
                terminal.draw(|f| terminals::draw_list(f, &items, selected, sidebar_width, &status))?;
                tokio::select! {
                    _ = refresh.tick() => {
                        items = terminals::fetch_terminals().await.unwrap_or_default();
                        if selected >= items.len() {
                            selected = items.len().saturating_sub(1);
                        }
                    }
                    maybe_event = events.next() => {
                        let Some(Ok(event)) = maybe_event else { continue };
                        match event {
                            Event::Mouse(mouse) => {
                                let total = terminal.size()?.width;
                                let rail = RailMouse {
                                    width: &mut sidebar_width,
                                    restored: &mut restored_width,
                                    dragging: &mut dragging_divider,
                                    total,
                                    height: terminal.size()?.height,
                                    rows: items.len(),
                                    header_lines: 0,
                                };
                                // Clicking a row connects to it, the way it does
                                // in the desktop panel: selecting without
                                // opening would leave the click half-done.
                                match rail.handle(mouse) {
                                    Some(RailClick::Select(index)) => {
                                        selected = index;
                                        if let Some(item) = items.get(index) {
                                            let area = terminals::terminal_area(
                                                terminal.size()?.into(), sidebar_width, &status,
                                            );
                                            match attach_to(&item.pty_id, area).await {
                                                Ok(next) => { status.clear(); mode = next; }
                                                Err(message) => status = message,
                                            }
                                        }
                                    }
                                    Some(RailClick::Action) => match new_agent(&cwd).await {
                                        Ok((fetched, index)) => {
                                            status.clear();
                                            items = fetched;
                                            if let Some(index) = index { selected = index; }
                                        }
                                        Err(message) => status = message,
                                    },
                                    None => {}
                                }
                            }
                            Event::Key(key) => {
                                if key.kind != KeyEventKind::Press { continue; }
                                match key.code {
                                    KeyCode::Up => selected = selected.saturating_sub(1),
                                    KeyCode::Down => {
                                        if selected + 1 < items.len() { selected += 1; }
                                    }
                                    KeyCode::Enter => {
                                        if let Some(item) = items.get(selected) {
                                            let area = terminals::terminal_area(
                                                terminal.size()?.into(), sidebar_width, &status,
                                            );
                                            match attach_to(&item.pty_id, area).await {
                                                Ok(next) => { status.clear(); mode = next; }
                                                Err(message) => status = message,
                                            }
                                        }
                                    }
                                    // A new agent is worth seeing immediately, so the
                                    // list is refetched now instead of waiting for the
                                    // next refresh tick, and the new row is selected.
                                    // A failure is reported: swallowing it made the key
                                    // look dead whenever the daemon was down.
                                    KeyCode::Char('n') => match new_agent(&cwd).await {
                                        Ok((fetched, index)) => {
                                            status.clear();
                                            items = fetched;
                                            if let Some(index) = index { selected = index; }
                                        }
                                        Err(message) => status = message,
                                    },
                                    KeyCode::Char('b') => {
                                        sidebar_width = toggle_sidebar(sidebar_width, &mut restored_width);
                                    }
                                    KeyCode::Tab => {
                                        review.enter();
                                        mode = Mode::Review;
                                    }
                                    KeyCode::Char('q') | KeyCode::Esc => return Ok(()),
                                    _ => {}
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
            // The terminal is drawn inside the right column: the emulator in
            // `screen` turns the pty's escape sequences into a grid, so its
            // "clear the screen" can no longer wipe the rail. No alt-screen
            // juggling either — the panel never gives up the screen now.
            Mode::Attached(attached) => {
                let Attached { session, screen } = &mut **attached;
                terminal.draw(|f| {
                    terminals::draw_attached(f, &items, selected, sidebar_width, &status, screen)
                })?;

                // The pty must wrap to the box it is painted in, and that box
                // changes whenever the window or the rail does.
                let area = terminals::terminal_area(terminal.size()?.into(), sidebar_width, &status);
                if screen.resize(area.height, area.width) {
                    session.resize(area.height, area.width);
                }

                tokio::select! {
                    maybe_event = events.next() => {
                        let Some(Ok(event)) = maybe_event else { continue };
                        match event {
                            Event::Key(key) if terminals::is_detach_key(key) => {
                                mode = Mode::List;
                                items = terminals::fetch_terminals().await.unwrap_or_default();
                                if selected >= items.len() {
                                    selected = items.len().saturating_sub(1);
                                }
                            }
                            // Reserved before the pty sees it, so a new agent
                            // can be opened without first going back.
                            Event::Key(key) if terminals::is_new_agent_key(key) => {
                                match new_agent(&cwd).await {
                                    Ok((fetched, index)) => {
                                        items = fetched;
                                        if let Some(index) = index {
                                            selected = index;
                                            if let Some(item) = items.get(index) {
                                                let area = terminals::terminal_area(
                                                    terminal.size()?.into(), sidebar_width, &status,
                                                );
                                                match attach_to(&item.pty_id, area).await {
                                                    Ok(next) => mode = next,
                                                    Err(message) => { status = message; mode = Mode::List; }
                                                }
                                            }
                                        }
                                    }
                                    Err(message) => { status = message; mode = Mode::List; }
                                }
                            }
                            Event::Key(key) => session.send_key(key),
                            // Handed to the remote program while it has asked
                            // for the mouse: vim and htop are unusable without
                            // it. The rail's own mouse waits until they give
                            // it back.
                            Event::Mouse(mouse) if screen.wants_mouse() => {
                                let area = terminals::terminal_area(
                                    terminal.size()?.into(), sidebar_width, &status,
                                );
                                let inside = mouse.column >= area.x
                                    && mouse.row >= area.y
                                    && mouse.column < area.x + area.width
                                    && mouse.row < area.y + area.height;
                                if inside {
                                    if let Some(bytes) = screen::encode_mouse(
                                        mouse.kind, mouse.column - area.x, mouse.row - area.y,
                                    ) {
                                        session.write(bytes);
                                    }
                                }
                            }
                            // The rail is still on screen while attached, so
                            // it still folds, resizes and — clicking another
                            // row — switches to that terminal.
                            Event::Mouse(mouse) => {
                                let total = terminal.size()?.width;
                                let rail = RailMouse {
                                    width: &mut sidebar_width,
                                    restored: &mut restored_width,
                                    dragging: &mut dragging_divider,
                                    total,
                                    height: terminal.size()?.height,
                                    rows: items.len(),
                                    header_lines: 0,
                                };
                                match rail.handle(mouse) {
                                    Some(RailClick::Select(index)) => {
                                        selected = index;
                                        if let Some(item) = items.get(index) {
                                            let area = terminals::terminal_area(
                                                terminal.size()?.into(), sidebar_width, &status,
                                            );
                                            match attach_to(&item.pty_id, area).await {
                                                Ok(next) => mode = next,
                                                Err(message) => { status = message; mode = Mode::List; }
                                            }
                                        }
                                    }
                                    // Opening a new agent from inside a terminal
                                    // switches straight into it: that is what the
                                    // click asked for.
                                    Some(RailClick::Action) => match new_agent(&cwd).await {
                                        Ok((fetched, index)) => {
                                            items = fetched;
                                            if let Some(index) = index {
                                                selected = index;
                                                if let Some(item) = items.get(index) {
                                                    let area = terminals::terminal_area(
                                                        terminal.size()?.into(), sidebar_width, &status,
                                                    );
                                                    match attach_to(&item.pty_id, area).await {
                                                        Ok(next) => mode = next,
                                                        Err(message) => { status = message; mode = Mode::List; }
                                                    }
                                                }
                                            }
                                        }
                                        Err(message) => { status = message; mode = Mode::List; }
                                    },
                                    None => {}
                                }
                            }
                            _ => {}
                        }
                    }
                    Some(bytes) = session.output_rx.recv() => screen.feed(&bytes),
                    _ = &mut session.exit_rx => {
                        mode = Mode::List;
                        items = terminals::fetch_terminals().await.unwrap_or_default();
                        if selected >= items.len() {
                            selected = items.len().saturating_sub(1);
                        }
                    }
                }
            }
            Mode::Review => {
                terminal.draw(|f| review::draw(f, &review, sidebar_width))?;
                tokio::select! {
                    maybe_event = events.next() => {
                        let Some(Ok(event)) = maybe_event else { continue };
                        // The rail is the same component here, so it gets the
                        // same mouse: folding and dragging must not depend on
                        // which panel you are looking at.
                        if let Event::Mouse(mouse) = event {
                            let total = terminal.size()?.width;
                            // The drawer's own edge and chevron, checked first:
                            // they sit to the right of everything the rail owns.
                            let drawer_left = total.saturating_sub(review.drawer_width);
                            if review.drawer_width > 0 {
                                match mouse.kind {
                                    MouseEventKind::Down(MouseButton::Left)
                                        if drawer::grabs_chevron(mouse.column, mouse.row, drawer_left) =>
                                    {
                                        review.toggle_drawer();
                                        continue;
                                    }
                                    MouseEventKind::Down(MouseButton::Left)
                                        if drawer::grabs_divider(mouse.column, drawer_left) =>
                                    {
                                        dragging_drawer = true;
                                        continue;
                                    }
                                    MouseEventKind::Drag(MouseButton::Left) if dragging_drawer => {
                                        review.drawer_width = drawer::width_after_drag(mouse.column, total);
                                        continue;
                                    }
                                    MouseEventKind::Up(MouseButton::Left) if dragging_drawer => {
                                        dragging_drawer = false;
                                        continue;
                                    }
                                    _ => {}
                                }
                            }
                            let rail = RailMouse {
                                width: &mut sidebar_width,
                                restored: &mut restored_width,
                                dragging: &mut dragging_divider,
                                total,
                                height: terminal.size()?.height,
                                rows: review.sidebar_len(),
                                header_lines: review.header_lines(),
                            };
                            match rail.handle(mouse) {
                                Some(RailClick::Select(index)) => review.select_sidebar(index),
                                Some(RailClick::Action) => review.toggle_run(),
                                None => {}
                            }
                            continue;
                        }
                        // Painted before the call, because the call itself
                        // blocks this loop: without a frame in between, a slow
                        // daemon looks like a hang. The header's own count
                        // follows the flag, so the rows stay where the click
                        // handler expects them.
                        if review.handle_event(event).await {
                            mode = Mode::List;
                        }
                    }
                    // Requests run off this loop now, so a slow daemon no
                    // longer stops the redraw or the keys.
                    Some(update) = review.next_update() => match update {
                        review::ReviewUpdate::Stream(event) => review.handle_stream_event(event),
                        review::ReviewUpdate::Work(fetched) => review.apply_fetched(fetched),
                    },
                }
            }
        }
    }
}

/// Connects to `pty_id` and returns the attached mode, or the message to show
/// when it fails. Shared by every route into a terminal — Enter, a click on a
/// row, and switching while already attached.
async fn attach_to(pty_id: &str, area: ratatui::layout::Rect) -> Result<Mode, String> {
    match terminals::Session::connect(pty_id, area.height, area.width).await {
        Ok(session) => Ok(Mode::Attached(Box::new(Attached {
            session,
            screen: screen::Screen::new(area.height, area.width),
        }))),
        Err(error) => Err(format!("No se pudo conectar: {error}")),
    }
}

/// Opens a terminal and reports where it landed in the refreshed list, so the
/// caller can select it. Shared by the "n" key and the rail's action button.
async fn new_agent(cwd: &str) -> Result<(Vec<terminals::TerminalInfo>, Option<usize>), String> {
    match terminals::open_terminal(cwd).await {
        Ok(pty_id) => {
            let items = terminals::fetch_terminals().await.unwrap_or_default();
            let index = items.iter().position(|t| t.pty_id == pty_id);
            Ok((items, index))
        }
        Err(error) => Err(format!("No se pudo abrir: {error}")),
    }
}

/// The rail's mouse behaviour, borrowed rather than owned so both the list
/// and the attached view drive the same one: connected, the rail is still
/// there and must still fold, resize and select.
struct RailMouse<'a> {
    width: &'a mut u16,
    restored: &'a mut u16,
    dragging: &'a mut bool,
    total: u16,
    height: u16,
    rows: usize,
    /// Lines of fixed context the rail paints above its rows. Ignoring it made
    /// every click in Review land on the wrong row (or on none).
    header_lines: u16,
}

/// What a click on the rail asked for. The action is whatever the panel
/// pinned to the bottom of its rail — a new agent, a review run.
enum RailClick {
    Select(usize),
    Action,
}

impl RailMouse<'_> {
    /// Returns what the click asked for, if anything.
    fn handle(self, mouse: crossterm::event::MouseEvent) -> Option<RailClick> {
        let on_chevron = mouse.row == 0 && mouse.column + 2 >= *self.width && mouse.column < *self.width;
        match mouse.kind {
            // The chevron sits on the rail's top-right corner; clicking it
            // folds and unfolds.
            MouseEventKind::Down(MouseButton::Left) if on_chevron => {
                *self.width = toggle_sidebar(*self.width, self.restored);
            }
            MouseEventKind::Down(MouseButton::Left) => {
                // The divider wins over the row underneath it: it overlaps the
                // rail's last column, and a resize misread as a selection
                // would swap terminals on every drag.
                *self.dragging = sidebar::grabs_divider(mouse.column, *self.width);
                if *self.dragging {
                    return None;
                }
                if sidebar::grabs_action(mouse.column, mouse.row, *self.width, self.height) {
                    return Some(RailClick::Action);
                }
                return sidebar::item_at_with_header(
                    mouse.column, mouse.row, *self.width, self.rows, self.header_lines,
                )
                .map(RailClick::Select);
            }
            MouseEventKind::Drag(MouseButton::Left) if *self.dragging => {
                *self.width = sidebar::width_after_drag(mouse.column, self.total);
            }
            MouseEventKind::Up(MouseButton::Left) => *self.dragging = false,
            _ => {}
        }
        None
    }
}

/// Folds the rail away, or unfolds it back to the width it had before —
/// remembered in `restored`, so a rail the user widened does not come back
/// as the default.
fn toggle_sidebar(current: u16, restored: &mut u16) -> u16 {
    if current > sidebar::COLLAPSED_WIDTH {
        *restored = current;
        return sidebar::COLLAPSED_WIDTH;
    }
    *restored
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folding_and_unfolding_returns_the_width_the_user_had_chosen() {
        let mut restored = sidebar::DEFAULT_WIDTH;

        let collapsed = toggle_sidebar(40, &mut restored);
        assert_eq!(collapsed, sidebar::COLLAPSED_WIDTH);
        assert_eq!(toggle_sidebar(collapsed, &mut restored), 40, "vuelve a 40, no al ancho por defecto");
    }

    #[test]
    fn folding_twice_does_not_lose_the_remembered_width() {
        // Collapsing an already-collapsed rail must not record the stub as the
        // width to restore, which would leave it stuck folded.
        let mut restored = 40;

        let once = toggle_sidebar(sidebar::COLLAPSED_WIDTH, &mut restored);
        assert_eq!(once, 40);
        assert_eq!(restored, 40);
    }
}

