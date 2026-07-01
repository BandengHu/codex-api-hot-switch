export function LogoutForm() {
  return (
    <form action="/api/auth/logout" method="post">
      <button className="logout-button" type="submit">退出登录</button>
    </form>
  );
}
