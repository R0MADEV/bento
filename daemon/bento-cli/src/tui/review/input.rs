//! Key handling for the Review tab, one handler per view. Every handler
//! returns `true` when the panel should go back to the terminals list.

use crossterm::event::{Event, KeyCode, KeyEventKind};
use serde_json::{json, Value};

use super::format::next_agent;
use super::{Focus, InputPurpose, ReviewState, ReviewView, SidebarTab};

impl ReviewState {
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
            ReviewView::Output => self.handle_output_key(key.code),
        }
    }

    async fn handle_browse_key(&mut self, code: KeyCode) -> bool {
        match code {
            KeyCode::Left => { self.focus = Focus::Sidebar; false }
            KeyCode::Right => { self.focus = Focus::Files; false }
            KeyCode::Char('r') => { self.start_run(); false }
            KeyCode::Char('g') => { self.agent = next_agent(&self.agent); false }
            KeyCode::F(5) => { self.refresh().await; false }
            KeyCode::Char('x') => { self.compare = !self.compare; false }
            KeyCode::Char('c') => {
                self.input_purpose = Some(InputPurpose::Context);
                self.input = self.context.clone();
                false
            }
            KeyCode::Char('o') => { self.set_sidebar_tab(SidebarTab::Projects).await; false }
            KeyCode::Char('b') => { self.set_sidebar_tab(SidebarTab::Branches).await; false }
            KeyCode::Char('p') => { self.set_sidebar_tab(SidebarTab::Prs).await; false }
            KeyCode::Char('h') => { self.set_sidebar_tab(SidebarTab::Checkpoints).await; false }
            KeyCode::Up | KeyCode::Down | KeyCode::Enter | KeyCode::Char(' ') | KeyCode::Char('f') | KeyCode::Char('d') | KeyCode::Char('v') => {
                match self.focus {
                    Focus::Sidebar => self.handle_sidebar_key(code).await,
                    Focus::Files => self.handle_files_key(code).await,
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
                    if self.projects_selected + 1 < self.projects.len() { self.projects_selected += 1; }
                    false
                }
                KeyCode::Enter => {
                    if let Some(cwd) = self.projects.get(self.projects_selected).and_then(|p| p.get("cwd")).and_then(Value::as_str) {
                        self.cwd = cwd.to_string();
                        self.enter().await;
                        self.focus = Focus::Sidebar;
                        self.sidebar_tab = SidebarTab::Branches;
                    }
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
                KeyCode::Enter => {
                    if let Some(b) = self.branches.get(self.branches_selected) {
                        self.base = b.clone();
                        self.refresh_files().await;
                        self.focus = Focus::Sidebar;
                    }
                    false
                }
                KeyCode::Char('v') => {
                    // Revisar esa rama contra la base, en vez del working tree.
                    if let Some(b) = self.branches.get(self.branches_selected).cloned() {
                        self.branch = if self.branch.as_deref() == Some(b.as_str()) { None } else { Some(b) };
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
                    if let Some(pr) = self.prs.get(self.prs_selected).and_then(|p| p.get("number")).and_then(Value::as_u64) {
                        self.load_pr_detail(pr).await;
                    }
                    false
                }
                _ => false,
            },
            SidebarTab::Checkpoints => match code {
                KeyCode::Up => { self.checkpoints_selected = self.checkpoints_selected.saturating_sub(1); false }
                KeyCode::Down => {
                    if self.checkpoints_selected + 1 < self.checkpoints.len() { self.checkpoints_selected += 1; }
                    false
                }
                KeyCode::Enter => {
                    if let Some(base) = self.checkpoints.get(self.checkpoints_selected).and_then(|c| c.get("base")).and_then(Value::as_str) {
                        let base = base.to_string();
                        let data = crate::request_data(json!({ "id": "1", "cmd": "review.checkpoint_get", "cwd": self.cwd, "base": base })).await;
                        if let Ok(cp) = data {
                            self.base = base;
                            self.output = cp.get("content").and_then(Value::as_str).unwrap_or_default().to_string();
                            self.session_id = cp.get("session_id").and_then(Value::as_str).map(String::from);
                            self.session_agent = cp.get("session_agent").and_then(Value::as_str).map(String::from);
                            self.scroll = 0;
                            self.running = false;
                            self.last_progress.clear();
                            self.view = ReviewView::Output;
                        }
                    }
                    false
                }
                KeyCode::Char('d') => {
                    if let Some(base) = self.checkpoints.get(self.checkpoints_selected).and_then(|c| c.get("base")).and_then(Value::as_str) {
                        let base = base.to_string();
                        let _ = crate::request_data(json!({ "id": "1", "cmd": "review.checkpoint_delete", "cwd": self.cwd, "base": base })).await;
                        self.checkpoints = self.fetch_list(json!({ "id": "1", "cmd": "review.checkpoints", "cwd": self.cwd })).await;
                        if self.checkpoints_selected >= self.checkpoints.len() {
                            self.checkpoints_selected = self.checkpoints.len().saturating_sub(1);
                        }
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
                    let data = crate::request_data(json!({
                        "id": "1", "cmd": "review.file", "cwd": self.cwd, "base": self.base, "path": path,
                    })).await;
                    self.file_diff = data.ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_else(|| "(no se pudo cargar el diff)".to_string());
                    self.file_scroll = 0;
                    self.view = ReviewView::FileDetail;
                }
                false
            }
            _ => false,
        }
    }

    fn handle_file_detail_key(&mut self, code: KeyCode) -> bool {
        match code {
            KeyCode::Up => { self.file_scroll = self.file_scroll.saturating_sub(1); false }
            KeyCode::Down => { self.file_scroll = self.file_scroll.saturating_add(1); false }
            KeyCode::PageUp => { self.file_scroll = self.file_scroll.saturating_sub(10); false }
            KeyCode::PageDown => { self.file_scroll = self.file_scroll.saturating_add(10); false }
            KeyCode::Tab => true,
            KeyCode::Char('q') | KeyCode::Esc => {
                self.view = ReviewView::Browse;
                false
            }
            _ => false,
        }
    }

    fn handle_pr_detail_key(&mut self, code: KeyCode) -> bool {
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

    fn handle_output_key(&mut self, code: KeyCode) -> bool {
        match code {
            KeyCode::Up => { self.scroll = self.scroll.saturating_sub(1); false }
            KeyCode::Down => { self.scroll = self.scroll.saturating_add(1); false }
            KeyCode::PageUp => { self.scroll = self.scroll.saturating_sub(10); false }
            KeyCode::PageDown => { self.scroll = self.scroll.saturating_add(10); false }
            KeyCode::Char('a') if !self.running => {
                self.input_purpose = Some(InputPurpose::Ask);
                self.input.clear();
                false
            }
            KeyCode::Char('c') if self.running => {
                if let Some(task) = self.stream_task.take() { task.abort(); }
                self.stream_rx = None;
                self.running = false;
                self.output.push_str("\n\n*(cancelado)*\n");
                false
            }
            KeyCode::Tab => true,
            KeyCode::Esc => {
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
                    Some(InputPurpose::PrReview(event)) => self.submit_pr_review(event).await,
                    Some(InputPurpose::Context) => self.context = std::mem::take(&mut self.input),
                    None => {}
                }
            }
            _ => {}
        }
    }

}
