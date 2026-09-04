//! Key handling for the Review tab, one handler per view. Every handler
//! returns `true` when the panel should go back to the terminals list.

use crossterm::event::{Event, KeyCode, KeyEventKind};
use serde_json::{json, Value};

use super::format::{next_agent, next_optional_agent};
use super::{Focus, InputPurpose, ReviewState, ReviewView, SidebarTab};

impl ReviewState {
    /// Abre el buscador con lo que ya hubiera escrito, para poder afinarlo.
    /// Abre el filtro de donde estés: el raíl filtra ramas, la derecha filtra
    /// ficheros y líneas. Dos cosas distintas, como los dos campos del panel
    /// del escritorio.
    fn start_search(&mut self) {
        let on_files = !matches!(self.focus, Focus::Sidebar);
        self.input_purpose = Some(match on_files {
            true => InputPurpose::FileSearch,
            false => InputPurpose::Search,
        });
        self.input = match on_files { true => self.file_search.clone(), false => self.search.clone() };
    }

    /// Handles one input event. Returns `true` if the panel should switch
    /// back to the terminals list.
    pub(crate) async fn handle_event(&mut self, event: Event) -> bool {
        let Event::Key(key) = event else { return false };
        if key.kind != KeyEventKind::Press {
            return false;
        }
        if self.input_purpose.is_some() {
            self.handle_text_input(key.code).await;
            return false;
        }
        match self.view {
            ReviewView::Browse => self.handle_browse_key(key.code).await,
            ReviewView::FileDetail => self.handle_file_detail_key(key.code),
            ReviewView::PrDetail => self.handle_pr_detail_key(key.code),
        }
    }

    async fn handle_browse_key(&mut self, code: KeyCode) -> bool {
        match code {
            KeyCode::Left => { self.focus_left(); false }
            KeyCode::Right => { self.focus_right(); false }
            KeyCode::Char('r') => { self.start_run(); false }
            KeyCode::Char('g') => { self.agent = next_agent(&self.agent); false }
            // The extra passes only mean anything while comparing, so picking
            // one turns compare on rather than silently doing nothing.
            KeyCode::Char('G') => {
                self.secondary = next_optional_agent(self.secondary.as_deref());
                self.compare = true;
                false
            }
            KeyCode::Char('t') => {
                self.tertiary = next_optional_agent(self.tertiary.as_deref());
                self.compare = true;
                false
            }
            KeyCode::F(5) => { self.request_refresh(); false }
            // F3 además de `/`: en un teclado español la barra es Shift+7 y en
            // algunas distribuciones no llega, así que la búsqueda se quedaba
            // sin tecla. F3 es la misma que busca en la pestaña de terminales.
            KeyCode::F(3) | KeyCode::Char('/') => { self.start_search(); false }
            KeyCode::Char('x') => { self.compare = !self.compare; false }
            KeyCode::Char('w') => { self.toggle_drawer(); false }
            // The saved reviews, in the drawer where their reports live. The
            // rail had a second copy of this list whose Enter ignored the run
            // id, so it opened the newest review of that branch rather than
            // the one you picked.
            KeyCode::Char('h') => { self.toggle_history(); false }
            // Asking about the report used to belong to the full-screen view;
            // the report is in the drawer now, so the key lives here.
            KeyCode::Char('a') if !self.running && !self.output.is_empty() => {
                self.input_purpose = Some(InputPurpose::Ask);
                self.input.clear();
                false
            }
            KeyCode::PageUp => { self.scroll = self.scroll.saturating_sub(10); false }
            KeyCode::PageDown => { self.scroll = self.scroll.saturating_add(10); false }
            KeyCode::Char('c') if self.running => { self.cancel_run(); false }
            KeyCode::Char('c') => {
                self.input_purpose = Some(InputPurpose::Context);
                self.input = self.context.clone();
                false
            }
            KeyCode::Char('o') => { self.request_sidebar_tab(SidebarTab::Projects); false }
            KeyCode::Char('b') => { self.request_sidebar_tab(SidebarTab::Branches); false }
            KeyCode::Char('p') => { self.request_sidebar_tab(SidebarTab::Prs); false }
            KeyCode::Up | KeyCode::Down | KeyCode::Enter | KeyCode::Char(' ') | KeyCode::Char('f') | KeyCode::Char('d') | KeyCode::Char('v') => {
                match self.focus {
                    Focus::Sidebar => self.handle_sidebar_key(code).await,
                    Focus::Files => self.handle_files_key(code).await,
                    // Arrows scroll the report; there is nothing to select in
                    // it, and everything else belongs to the panel.
                    // Listing past reviews, the arrows move a selection and
                    // Enter opens one; showing a report, they scroll it.
                    Focus::Drawer if self.showing_history => {
                        match code {
                            KeyCode::Up => self.checkpoints_selected = self.checkpoints_selected.saturating_sub(1),
                            KeyCode::Down => {
                                if self.checkpoints_selected + 1 < self.checkpoints.len() {
                                    self.checkpoints_selected += 1;
                                }
                            }
                            KeyCode::Enter => self.open_selected_review().await,
                            KeyCode::Char('d') => self.delete_selected_review().await,
                            _ => {}
                        }
                        false
                    }
                    Focus::Drawer => {
                        match code {
                            KeyCode::Up => self.scroll_drawer(-1),
                            KeyCode::Down => self.scroll_drawer(1),
                            _ => {}
                        }
                        false
                    }
                }
            }
            KeyCode::Tab | KeyCode::Char('q') | KeyCode::Esc => true,
            _ => false,
        }
    }

    async fn handle_sidebar_key(&mut self, code: KeyCode) -> bool {
        match self.sidebar_tab {
            SidebarTab::Projects => match code {
                KeyCode::Up => { self.projects_selected = self.projects_selected.saturating_sub(1); false }
                KeyCode::Down => {
                    if self.projects_selected + 1 < self.browse_dirs.len() { self.projects_selected += 1; }
                    false
                }
                // Enter entra en la carpeta; espacio se queda con la que estás
                // mirando. Es el mismo gesto que el navegador del móvil.
                KeyCode::Enter => {
                    if let Some(name) = self.browse_dirs.get(self.projects_selected).cloned() {
                        self.browse_path = match name.as_str() {
                            ".." => self.browse_path.parent().map(std::path::Path::to_path_buf).unwrap_or_else(|| self.browse_path.clone()),
                            name => self.browse_path.join(name),
                        };
                        self.refresh_browse();
                    }
                    false
                }
                // Espacio elige la carpeta marcada, que es lo que hace un
                // selector: entrar en ella para luego elegirla era un paso de
                // más, y no se adivina.
                KeyCode::Char(' ') => {
                    let chosen = match self.browse_dirs.get(self.projects_selected).map(String::as_str) {
                        Some("..") => self.browse_path.parent().map(std::path::Path::to_path_buf),
                        Some(name) => Some(self.browse_path.join(name)),
                        None => Some(self.browse_path.clone()),
                    };
                    let Some(chosen) = chosen else { return false };
                    // Sin repositorio no hay nada que revisar, y git contestaría
                    // con su propio error pegado en el panel.
                    if !super::format::is_repo(&chosen) {
                        self.status = format!("{} no es un repositorio git", chosen.display());
                        return false;
                    }
                    self.cwd = chosen.display().to_string();
                    // Cada proyecto tiene su rama principal: quedarse con la
                    // base del anterior es comparar contra algo que aquí igual
                    // ni existe.
                    self.base = super::default_base(&self.cwd);
                    self.branch = None;
                    self.enter();
                    self.focus = Focus::Sidebar;
                    self.sidebar_tab = SidebarTab::Branches;
                    false
                }
                _ => false,
            },
            SidebarTab::Branches => match code {
                KeyCode::Up => { self.branches_selected = self.branches_selected.saturating_sub(1); false }
                KeyCode::Down => {
                    if self.branches_selected + 1 < self.branches.len() { self.branches_selected += 1; }
                    false
                }
                // Enter revisa esa rama contra la base, que es lo que hace la
                // lista del escritorio. Antes la ponía como base, así que la
                // misma fila hacía cosas distintas en cada cliente.
                KeyCode::Enter => {
                    if let Some(b) = self.branches.get(self.branches_selected).cloned() {
                        self.branch = Some(b);
                        self.refresh_files().await;
                        self.focus = Focus::Sidebar;
                    }
                    false
                }
                // Y espacio la usa de base, que es el otro gesto que hace falta
                // y en el escritorio es el campo de arriba.
                KeyCode::Char(' ') => {
                    if let Some(b) = self.branches.get(self.branches_selected).cloned() {
                        self.base = b;
                        self.branch = None;
                        self.refresh_files().await;
                    }
                    false
                }
                KeyCode::Char('v') => {
                    // Volver al árbol de trabajo: sin rama, la lista son tus
                    // cambios sin commitear contra la base.
                    if let Some(b) = self.branches.get(self.branches_selected).cloned() {
                        self.branch = if self.branch.as_deref() == Some(b.as_str()) { None } else { Some(b) };
                        self.refresh_files().await;
                    }
                    false
                }
                _ => false,
            },
            SidebarTab::Prs => match code {
                KeyCode::Up => { self.prs_selected = self.prs_selected.saturating_sub(1); false }
                KeyCode::Down => {
                    if self.prs_selected + 1 < self.prs.len() { self.prs_selected += 1; }
                    false
                }
                KeyCode::Enter => {
                    let Some(entry) = self.prs.get(self.prs_selected).cloned() else { return false };
                    // Abrir un PR deja la review puesta en su rama, como en el
                    // escritorio: si no, mirabas el detalle del PR y la lista de
                    // ficheros seguía siendo la de antes.
                    if let Some(head) = entry.get("headRefName").and_then(Value::as_str) {
                        self.branch = Some(head.to_string());
                        self.refresh_files().await;
                    }
                    if let Some(pr) = entry.get("number").and_then(Value::as_u64) {
                        self.load_pr_detail(pr).await;
                    }
                    false
                }
                _ => false,
            },
        }
    }

    async fn handle_files_key(&mut self, code: KeyCode) -> bool {
        let visible_len = self.visible_files().len();
        match code {
            KeyCode::Up => { self.files_selected = self.files_selected.saturating_sub(1); false }
            KeyCode::Down => {
                if self.files_selected + 1 < visible_len { self.files_selected += 1; }
                false
            }
            KeyCode::Char(' ') => {
                if let Some(path) = self.visible_files().get(self.files_selected).and_then(|f| f.get("path")).and_then(Value::as_str).map(String::from) {
                    if !self.reviewed.remove(&path) { self.reviewed.insert(path); }
                    self.save_reviewed();
                }
                false
            }
            KeyCode::Char('f') => {
                self.file_filter = self.file_filter.next();
                self.files_selected = 0;
                false
            }
            KeyCode::Enter => {
                if let Some(path) = self.visible_files().get(self.files_selected).and_then(|f| f.get("path")).and_then(Value::as_str).map(String::from) {
                    let mut body = json!({
                        "id": "1", "cmd": "review.file", "cwd": self.cwd, "base": self.base, "path": path,
                    });
                    // Con rama elegida, el diff es el suyo; sin ella, el del
                    // árbol de trabajo. Sin mandarla se abría el segundo.
                    if let Some(branch) = &self.branch {
                        body["branch"] = json!(branch);
                    }
                    let data = crate::request_data(body).await;
                    self.file_diff = data.ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_else(|| "(no se pudo cargar el diff)".to_string());
                    self.current_file = Some(path);
                    self.file_scroll = 0;
                    self.view = ReviewView::FileDetail;
                }
                false
            }
            _ => false,
        }
    }

    fn handle_file_detail_key(&mut self, code: KeyCode) -> bool {
        if matches!(code, KeyCode::F(3) | KeyCode::Char('/')) {
            self.start_search();
            return false;
        }
        match code {
            KeyCode::Up => { self.file_scroll = self.file_scroll.saturating_sub(1); false }
            KeyCode::Down => { self.file_scroll = self.file_scroll.saturating_add(1); false }
            KeyCode::PageUp => { self.file_scroll = self.file_scroll.saturating_sub(10); false }
            KeyCode::PageDown => { self.file_scroll = self.file_scroll.saturating_add(10); false }
            // Comentar la línea marcada, que es lo que el escritorio sabía
            // hacer y esta no.
            KeyCode::Char('c') => { self.start_inline_comment(); false }
            KeyCode::Tab => true,
            KeyCode::Char('q') | KeyCode::Esc => {
                self.view = ReviewView::Browse;
                false
            }
            _ => false,
        }
    }

    fn handle_pr_detail_key(&mut self, code: KeyCode) -> bool {
        if matches!(code, KeyCode::F(3) | KeyCode::Char('/')) {
            self.start_search();
            return false;
        }
        match code {
            KeyCode::Up => { self.pr_scroll = self.pr_scroll.saturating_sub(1); false }
            KeyCode::Down => { self.pr_scroll = self.pr_scroll.saturating_add(1); false }
            KeyCode::PageUp => { self.pr_scroll = self.pr_scroll.saturating_sub(10); false }
            KeyCode::PageDown => { self.pr_scroll = self.pr_scroll.saturating_add(10); false }
            KeyCode::Char('a') => {
                self.input_purpose = Some(InputPurpose::PrComment);
                self.input.clear();
                false
            }
            KeyCode::Char('y') => {
                self.input_purpose = Some(InputPurpose::PrReview("APPROVE"));
                self.input.clear();
                false
            }
            KeyCode::Char('n') => {
                self.input_purpose = Some(InputPurpose::PrReview("REQUEST_CHANGES"));
                self.input.clear();
                false
            }
            KeyCode::Char('m') => {
                self.input_purpose = Some(InputPurpose::PrReview("COMMENT"));
                self.input.clear();
                false
            }
            KeyCode::Tab => true,
            KeyCode::Char('q') | KeyCode::Esc => {
                self.view = ReviewView::Browse;
                false
            }
            _ => false,
        }
    }


    async fn handle_text_input(&mut self, code: KeyCode) {
        match code {
            KeyCode::Char(c) => self.input.push(c),
            KeyCode::Backspace => { self.input.pop(); }
            KeyCode::Esc => {
                self.input_purpose = None;
                self.input.clear();
            }
            KeyCode::Enter => {
                match self.input_purpose.take() {
                    Some(InputPurpose::Ask) => {
                        if !self.input.trim().is_empty() { self.start_ask(); }
                    }
                    Some(InputPurpose::PrComment) => self.submit_pr_comment().await,
                    Some(InputPurpose::InlineComment(line)) => self.submit_inline_comment(line).await,
                    Some(InputPurpose::PrReview(event)) => self.submit_pr_review(event).await,
                    Some(InputPurpose::Context) => self.context = std::mem::take(&mut self.input),
                    Some(InputPurpose::Search) => {
                        self.search = std::mem::take(&mut self.input);
                        self.branches_selected = 0;
                    }
                    Some(InputPurpose::FileSearch) => {
                        self.file_search = std::mem::take(&mut self.input);
                        self.files_selected = 0;
                    }
                    None => {}
                }
            }
            _ => {}
        }
    }

}
