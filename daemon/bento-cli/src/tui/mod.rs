//! Full-screen panel mode: a navigable list of terminals/agents, with
//! inline attach (returns to the list when the remote session ends), plus a
//! Review tab for running AI code reviews without leaving the terminal.

mod drawer;
mod pane;
mod review;
mod rail;
mod screen;
mod sidebar;
mod terminals;

use rail::{toggle_sidebar, RailClick, RailMouse};
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
    // Lo que se está buscando en lo que ya salió, mientras se escribe. Vive
    // aquí porque mientras hay buscador las teclas son suyas y no del programa.
    let mut searching: Option<String> = None;
    // Los perfiles guardados, del mismo fichero que escribe el escritorio, y
    // cuál se usará al abrir la siguiente. Se leen una vez: cambian poco y
    // releerlos por fotograma sería un fichero por fotograma.
    // En modo tamaño las flechas mueven los bordes en vez de la selección, que
    // es la única forma de cambiarlos sin ratón.
    let mut resizing = false;
    let profiles = bento_core::profiles::list();
    let mut profile: Option<usize> = None;
    let mut status = String::new();

    loop {
        match &mut mode {
            Mode::List => {
                terminal.draw(|f| {
                    terminals::draw_list(
                        f, &items, selected, sidebar_width, &status,
                        terminals::ListState {
                            profile: profile.map(|index| profiles[index].name.as_str()),
                            resizing,
                        },
                    )
                })?;
                tokio::select! {
                    _ = refresh.tick() => {
                        items = terminals::fetch_terminals().await.unwrap_or_default();
                        if selected >= items.len() {
                            selected = items.len().saturating_sub(1);
                        }
                    }
                    maybe_event = events.next() => {
                        let Some(Ok(event)) = maybe_event else { continue };
                        // El modo tamaño se come las flechas mientras está
                        // puesto, así que va antes que nadie.
                        if let Event::Key(key) = event {
                            let total = terminal.size()?.width;
                            match rail::resize_key(key, resizing) {
                                Some(rail::Resize::Toggle) => { resizing = !resizing; continue }
                                Some(rail::Resize::Exit) => { resizing = false; continue }
                                Some(rail::Resize::Rail(delta)) => {
                                    sidebar_width = sidebar::width_after_nudge(sidebar_width, delta, total);
                                    continue;
                                }
                                // El informe es de la otra pestaña.
                                Some(rail::Resize::Drawer(_)) => continue,
                                None => {}
                            }
                        }
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
                                            match terminals::attach_to(&item.pty_id, area).await {
                                                Ok(next) => { status.clear(); mode = next; }
                                                Err(message) => status = message,
                                            }
                                        }
                                    }
                                    Some(RailClick::Action) => match terminals::new_agent(&terminals::cwd_for_new(&items, selected, &cwd), profile.map(|index| profiles[index].shell.as_str())).await {
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
                                            match terminals::attach_to(&item.pty_id, area).await {
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
                                    KeyCode::Char('n') => match terminals::new_agent(&terminals::cwd_for_new(&items, selected, &cwd), profile.map(|index| profiles[index].shell.as_str())).await {
                                        Ok((fetched, index)) => {
                                            status.clear();
                                            items = fetched;
                                            if let Some(index) = index { selected = index; }
                                        }
                                        Err(message) => status = message,
                                    },
                                    // Cerrar el que está seleccionado. El
                                    // escritorio y el móvil ya podían; esta
                                    // era la única que solo sabía abrirlos.
                                    KeyCode::Char('k') => {
                                        if let Some(item) = items.get(selected) {
                                            match terminals::close_terminal(&item.pty_id).await {
                                                Ok(()) => {
                                                    selected = terminals::selection_after_close(items.len(), selected);
                                                    items = terminals::fetch_terminals().await.unwrap_or_default();
                                                    status.clear();
                                                }
                                                Err(error) => status = format!("No se pudo cerrar: {error}"),
                                            }
                                        }
                                    }
                                    // Saltar a una terminal por su número, que
                                    // es el que lleva pintado en el raíl.
                                    KeyCode::Char(c) if c.is_ascii_digit() && c != '0' => {
                                        let index = c as usize - '1' as usize;
                                        if index < items.len() { selected = index; }
                                    }
                                    // Con qué perfil abrir la siguiente, dando
                                    // la vuelta a la lista. Mismo gesto que
                                    // elegir agente en la pestaña de review.
                                    KeyCode::Char('p') => {
                                        profile = terminals::next_profile(profiles.len(), profile);
                                    }
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
                    terminals::draw_attached(
                        f, &items, selected, sidebar_width, &status, screen, searching.as_deref(),
                    )
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
                            // Con el buscador abierto las teclas son suyas.
                            Event::Key(key) if searching.is_some() => {
                                let term = searching.take().unwrap_or_default();
                                let (left, aviso) = screen::search_key(screen, term, key.code);
                                searching = left;
                                status = aviso;
                            }
                            Event::Key(key) if terminals::is_search_key(key) => {
                                searching = Some(searching.take().unwrap_or_default());
                            }
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
                                match terminals::new_agent(&terminals::cwd_for_new(&items, selected, &cwd), profile.map(|index| profiles[index].shell.as_str())).await {
                                    Ok((fetched, index)) => {
                                        items = fetched;
                                        if let Some(index) = index {
                                            selected = index;
                                            if let Some(item) = items.get(index) {
                                                let area = terminals::terminal_area(
                                                    terminal.size()?.into(), sidebar_width, &status,
                                                );
                                                match terminals::attach_to(&item.pty_id, area).await {
                                                    Ok(next) => mode = next,
                                                    Err(message) => { status = message; mode = Mode::List; }
                                                }
                                            }
                                        }
                                    }
                                    Err(message) => { status = message; mode = Mode::List; }
                                }
                            }
                            // Mirar lo que ya salió, como en el escritorio y
                            // el móvil. No se le manda al programa: es la vista
                            // de este panel la que se mueve.
                            Event::Key(key) if terminals::scrollback_keys(key).is_some() => {
                                if let Some(lines) = terminals::scrollback_keys(key) {
                                    screen.scroll_back(lines);
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
                                            match terminals::attach_to(&item.pty_id, area).await {
                                                Ok(next) => mode = next,
                                                Err(message) => { status = message; mode = Mode::List; }
                                            }
                                        }
                                    }
                                    // Opening a new agent from inside a terminal
                                    // switches straight into it: that is what the
                                    // click asked for.
                                    Some(RailClick::Action) => match terminals::new_agent(&terminals::cwd_for_new(&items, selected, &cwd), profile.map(|index| profiles[index].shell.as_str())).await {
                                        Ok((fetched, index)) => {
                                            items = fetched;
                                            if let Some(index) = index {
                                                selected = index;
                                                if let Some(item) = items.get(index) {
                                                    let area = terminals::terminal_area(
                                                        terminal.size()?.into(), sidebar_width, &status,
                                                    );
                                                    match terminals::attach_to(&item.pty_id, area).await {
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
                terminal.draw(|f| review::draw(f, &review, sidebar_width, resizing))?;
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
                                    // Listing past reviews, its rows are the
                                    // point of the column: reachable by mouse
                                    // like every other list in the panel.
                                    MouseEventKind::Down(MouseButton::Left)
                                        if review.showing_history && mouse.column > drawer_left =>
                                    {
                                        if let Some(index) = drawer::history_row_at(
                                            mouse.row,
                                            review.checkpoints_len(),
                                        ) {
                                            review.select_checkpoint(index);
                                        }
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
                        // El mismo modo tamaño que en la lista: aquí hay dos
                        // bordes que mover, el del raíl y el del informe. Con un
                        // cuadro de texto abierto no, que ahí una "s" es una "s".
                        let typing = review.is_typing();
                        if let Event::Key(key) = event {
                          if !typing {
                            let total = terminal.size()?.width;
                            match rail::resize_key(key, resizing) {
                                Some(rail::Resize::Toggle) => { resizing = !resizing; continue }
                                Some(rail::Resize::Exit) => { resizing = false; continue }
                                Some(rail::Resize::Rail(delta)) => {
                                    sidebar_width = sidebar::width_after_nudge(sidebar_width, delta, total);
                                    continue;
                                }
                                Some(rail::Resize::Drawer(delta)) => { review.nudge_drawer(delta, total); continue }
                                None => {}
                            }
                          }
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
