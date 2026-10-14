export function ProfileScreen() {
  return (
    <section className="screen profile-screen" data-testid="profile-screen">
      <div className="profile-hero">
        <span className="profile-avatar">А</span>
        <div><small>Текущий пользователь</small><h2>Анна</h2><p>Администратор</p></div>
        <i aria-label="Сессия активна"/>
      </div>

      <section className="profile-center-card">
        <span>Рабочий центр</span>
        <h3>DetailFlow Studio</h3>
        <p>Все записи, заказы и статистика показываются только для этого центра.</p>
        <div><span>Статус</span><strong><i/> Активен</strong></div>
      </section>

      <section className="profile-settings" aria-label="Параметры центра">
        <h3>Параметры</h3>
        <div><span><i>◷</i><b>Часовой пояс</b></span><strong>Москва · UTC+3</strong></div>
        <div><span><i>₽</i><b>Валюта смет</b></span><strong>Российский рубль</strong></div>
        <div><span><i>RU</i><b>Язык интерфейса</b></span><strong>Русский</strong></div>
      </section>

      <p className="profile-version">DetailFlow · локальная рабочая версия</p>
    </section>
  );
}
