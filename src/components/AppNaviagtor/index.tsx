import { Link } from 'ice';

export default function AppNav() {
  return (
    <ul>
        <li><Link to="/">Index</Link></li>
        <li><Link to="/home">Home</Link></li>
        <li><Link to="/ug">UG</Link></li>
        <li><Link to="/chat">Chat</Link></li>
        {/* <li><a href="/home">Home</a></li>
        <li><a href="/ug">UG</a></li> */}
      </ul>
  );
}