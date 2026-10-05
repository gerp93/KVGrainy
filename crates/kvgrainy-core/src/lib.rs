//! Fit an image under a size limit with the best quality possible.
//!
//! The engine is UI-agnostic: load with [`load::load_image`], then call
//! [`search::optimize`] with a size limit. Searching can be cancelled and
//! reports progress through callbacks so any front end can drive it.

pub mod encode;
pub mod limit;
pub mod load;
pub mod raster;
pub mod score;
pub mod search;

pub use encode::Format;
pub use limit::parse_size_limit;
pub use search::{optimize, Candidate, Error, Options, Progress};
