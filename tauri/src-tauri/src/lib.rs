// 库入口。桌面端 main.rs 只是薄薄一层调用 run()。
// 逻辑全在 app.rs，这里做模块声明。

mod app;

pub use app::run;
