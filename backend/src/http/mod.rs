//! The HTTP layer. `routes/` lists every endpoint next to its handler,
//! `route` is how they are registered, `middleware` is what every request
//! passes through, and whatever matches no route is an asset or `unmatched`.
mod assets;
mod input;
mod middleware;
mod route;
mod routes;
mod unmatched;

pub use assets::{Asset, assets, browser_update_ready};
pub use route::{Access, Route, Work};

use crate::State;
use axum::{
    Router,
    extract::{Request, State as AxumState},
    http::Method,
    response::Response,
    routing::{MethodFilter, MethodRouter},
};
use std::{collections::BTreeMap, sync::Arc};

/// Every registered route. `backend/tests/http_routes.rs` holds the expected list.
pub fn table() -> Vec<Route> {
    routes::all()
}

pub fn router(state: Arc<State>) -> Router {
    let mut paths: BTreeMap<String, MethodRouter<Arc<State>>> = BTreeMap::new();
    for route in table() {
        let route = Arc::new(route);
        let filter = MethodFilter::try_from(route.method.clone()).expect("a routable method");
        // An empty segment where a parameter belongs reaches the same handler, whose
        // own validation then answers, as it did before paths were matched by a table.
        let empty = route
            .path
            .split('/')
            .map(|part| if part.starts_with('{') { "" } else { part })
            .collect::<Vec<_>>()
            .join("/");
        for path in BTreeMap::from([(route.path.to_owned(), ()), (empty, ())]).into_keys() {
            let route = route.clone();
            let handler = move |AxumState(state): AxumState<Arc<State>>, request: Request| {
                let route = route.clone();
                async move { route.serve(state, request).await }
            };
            // Another method on a known path is as unknown as any other path, HEAD included.
            let methods = paths.remove(&path).unwrap_or_else(|| {
                MethodRouter::new()
                    .on(MethodFilter::HEAD, unmatched::unmatched)
                    .fallback(unmatched::unmatched)
            });
            paths.insert(path, methods.on(filter, handler));
        }
    }
    let router = paths
        .into_iter()
        .fold(Router::new(), |router, (path, methods)| {
            router.route(&path, methods)
        });
    router
        .fallback(fallback)
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            middleware::pipeline,
        ))
        .with_state(state)
}

async fn fallback(AxumState(state): AxumState<Arc<State>>, request: Request) -> Response {
    let path = request.uri().path();
    let asset = [Method::GET, Method::HEAD].contains(request.method())
        && (path == "/" || path.starts_with("/assets/"));
    if asset {
        return assets::serve(&state, request.method(), path, request.headers())
            .unwrap_or_else(middleware::failure);
    }
    unmatched::unmatched(AxumState(state), request).await
}
