//! How an endpoint is registered. Every helper takes the access the route
//! requires, so a route cannot exist without one, and hands the handler only
//! what that access produced.
use super::{
    input::{Input, Reply},
    middleware,
};
use crate::{
    Result, State,
    accounts::{Auth, Context},
    crypto,
    db::Store,
    ensure,
};
use axum::{
    extract::Request,
    http::Method,
    response::{IntoResponse, Response},
};
use std::{future::Future, pin::Pin, sync::Arc};

/// Who may call a route, as listed in the route inventory.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    /// Anyone, signed in or not.
    Public,
    /// Any signed-in user.
    Session,
    /// A signed-in platform owner.
    PlatformOwner,
    /// A member looking at a DSP through a role holding one of the `|`-separated permissions.
    Dsp(&'static str),
}

/// The access a route is registered with. Authorizing yields what the handler works with.
pub trait Grant: Copy + Send + Sync + 'static {
    type Who: Send + 'static;
    fn access(self) -> Access;
    /// Runs inside the same database closure as the handler's own work, so the
    /// check and what it guards are one step under the platform lock.
    fn authorize(self, db: &Store, input: &Input) -> Result<Self::Who>;
}
#[derive(Clone, Copy)]
pub struct Public;
#[derive(Clone, Copy)]
pub struct Session;
#[derive(Clone, Copy)]
pub struct PlatformOwner;
#[derive(Clone, Copy)]
pub struct Dsp(pub &'static str);

impl Grant for Public {
    type Who = ();
    fn access(self) -> Access {
        Access::Public
    }
    fn authorize(self, _: &Store, _: &Input) -> Result<()> {
        Ok(())
    }
}
impl Grant for Session {
    type Who = Auth;
    fn access(self) -> Access {
        Access::Session
    }
    fn authorize(self, db: &Store, input: &Input) -> Result<Auth> {
        let auth = db.authenticate(input.session_token())?;
        if input.method == Method::POST {
            let sent = input.header("x-csrf-token");
            ensure(crypto::equal(&auth.csrf, sent), "csrf_required", 403)?;
        }
        Ok(auth)
    }
}
impl Grant for PlatformOwner {
    type Who = Auth;
    fn access(self) -> Access {
        Access::PlatformOwner
    }
    fn authorize(self, db: &Store, input: &Input) -> Result<Auth> {
        let auth = Session.authorize(db, input)?;
        let owner = auth.user.platform_owner;
        ensure(owner, "platform_owner_required", 403)?;
        Ok(auth)
    }
}
impl Grant for Dsp {
    type Who = Context;
    fn access(self) -> Access {
        Access::Dsp(self.0)
    }
    fn authorize(self, db: &Store, input: &Input) -> Result<Context> {
        let auth = Session.authorize(db, input)?;
        db.from_view(&auth, input.header("x-dispatch-view"), self.0)
    }
}
impl Dsp {
    /// Checks again, after work done outside the database, that the member may still do this.
    pub fn revalidate(self, db: &Store, context: &Context) -> Result<Context> {
        db.revalidate(context, self.0)
    }
}

/// What a database handler works with: who is calling, and the shared state.
pub struct Ctx<'a, W> {
    pub state: &'a State,
    who: W,
}
impl<W> std::ops::Deref for Ctx<'_, W> {
    type Target = W;
    fn deref(&self) -> &W {
        &self.who
    }
}
impl Ctx<'_, Auth> {
    /// The signed-in user's id, for the audit log.
    pub fn actor(&self) -> &str {
        self.who.user.id.as_str()
    }
}
impl Ctx<'_, Context> {
    pub fn actor(&self) -> &str {
        self.who.auth.user.id.as_str()
    }
    pub fn dsp_id(&self) -> &str {
        self.who.dsp.id.as_str()
    }
}
pub type Anyone<'a> = Ctx<'a, ()>;
pub type User<'a> = Ctx<'a, Auth>;
pub type Member<'a> = Ctx<'a, Context>;

/// Which database access a route's work runs under.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Work {
    /// One closure under the shared lock: `State::read`.
    Read,
    /// One closure under the exclusive platform lock: `State::run`.
    Write,
    /// An async handler that makes its own `State::read` and `State::run` calls.
    Async,
    /// Answered from memory, before the query and body are even parsed.
    Memory,
}

type Blocking = Arc<dyn Fn(&Store, &State, &Input) -> Result<Reply> + Send + Sync>;
type Pending = Pin<Box<dyn Future<Output = Result<Reply>> + Send>>;
enum Handler {
    Blocking(Blocking),
    Async(Box<dyn Fn(Arc<State>, Input) -> Pending + Send + Sync>),
    Memory(fn(&State) -> Reply),
}

pub struct Route {
    pub method: Method,
    pub path: &'static str,
    pub access: Access,
    pub work: Work,
    pub invalidates_schedules: bool,
    handler: Handler,
}

fn blocking<A: Grant>(
    path: &'static str,
    access: A,
    work: Work,
    method: Method,
    handler: impl Fn(&Store, &Ctx<'_, A::Who>, &Input) -> Result<Reply> + Send + Sync + 'static,
) -> Route {
    let handler = move |db: &Store, state: &State, input: &Input| {
        let who = access.authorize(db, input)?;
        handler(db, &Ctx { state, who }, input)
    };
    Route {
        method,
        path,
        access: access.access(),
        work,
        invalidates_schedules: false,
        handler: Handler::Blocking(Arc::new(handler)),
    }
}
/// `GET path`: authorizes, then runs the handler, in one shared-lock database closure.
pub fn read<A: Grant>(
    path: &'static str,
    access: A,
    handler: impl Fn(&Store, &Ctx<'_, A::Who>, &Input) -> Result<Reply> + Send + Sync + 'static,
) -> Route {
    blocking(path, access, Work::Read, Method::GET, handler)
}
/// `POST path`: authorizes, then runs the handler, in one closure under the platform write lock.
pub fn write<A: Grant>(
    path: &'static str,
    access: A,
    handler: impl Fn(&Store, &Ctx<'_, A::Who>, &Input) -> Result<Reply> + Send + Sync + 'static,
) -> Route {
    blocking(path, access, Work::Write, Method::POST, handler)
}
fn asynchronous<A: Grant, F>(
    method: Method,
    path: &'static str,
    access: A,
    handler: impl Fn(Arc<State>, Input, A) -> F + Send + Sync + 'static,
) -> Route
where
    F: Future<Output = Result<Reply>> + Send + 'static,
{
    let handler = move |state, input| Box::pin(handler(state, input, access)) as Pending;
    Route {
        method,
        path,
        access: access.access(),
        work: Work::Async,
        invalidates_schedules: false,
        handler: Handler::Async(Box::new(handler)),
    }
}
/// `GET path` for work that waits outside the database. The handler receives the
/// registered access and must call `access.authorize(db, &input)` inside its own
/// `state.read`/`state.run` closure; leaving `access` unused fails the build's lints.
pub fn async_get<A: Grant, F>(
    path: &'static str,
    access: A,
    handler: impl Fn(Arc<State>, Input, A) -> F + Send + Sync + 'static,
) -> Route
where
    F: Future<Output = Result<Reply>> + Send + 'static,
{
    asynchronous(Method::GET, path, access, handler)
}
/// `POST path` for work that waits outside the database. See [`async_get`].
pub fn async_post<A: Grant, F>(
    path: &'static str,
    access: A,
    handler: impl Fn(Arc<State>, Input, A) -> F + Send + Sync + 'static,
) -> Route
where
    F: Future<Output = Result<Reply>> + Send + 'static,
{
    asynchronous(Method::POST, path, access, handler)
}
/// A public `GET` answered from memory: no session, query, body or database.
pub fn probe(path: &'static str, handler: fn(&State) -> Reply) -> Route {
    Route {
        method: Method::GET,
        path,
        access: Access::Public,
        work: Work::Memory,
        invalidates_schedules: false,
        handler: Handler::Memory(handler),
    }
}

impl Route {
    /// Wakes the scheduler after the handler succeeds, because the route
    /// changes which DSPs or schedules exist.
    pub fn invalidates_schedules(mut self) -> Self {
        self.invalidates_schedules = true;
        self
    }
    /// Answers `GET` although it was registered with `write`, for a read that
    /// still has to record something.
    pub fn get(mut self) -> Self {
        self.method = Method::GET;
        self
    }
    pub(super) async fn serve(&self, state: Arc<State>, request: Request) -> Response {
        match self.answer(state, request).await {
            Ok(reply) => reply.into_response(),
            Err(error) => middleware::failure(error),
        }
    }
    async fn answer(&self, state: Arc<State>, request: Request) -> Result<Reply> {
        let handler = match &self.handler {
            Handler::Memory(handler) => return Ok(handler(&state)),
            Handler::Async(handler) => {
                let input = middleware::input(&state, request, self.path).await?;
                return handler(state, input).await;
            }
            Handler::Blocking(handler) => handler.clone(),
        };
        let input = middleware::input(&state, request, self.path).await?;
        let shared = state.clone();
        let work = move |db: &Store| handler(db, &shared, &input);
        let reply = if self.work == Work::Read {
            state.read(work).await?
        } else {
            state.run(work).await?
        };
        if self.invalidates_schedules {
            state
                .schedule_revision
                .fetch_add(1, std::sync::atomic::Ordering::Release);
        }
        Ok(reply)
    }
}
