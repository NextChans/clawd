import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import Details from './Details';
import './styles.css';

// Both windows load the same bundle; the query flag picks the view.
const isDetails = new URLSearchParams(window.location.search).get('window') === 'details';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>{isDetails ? <Details /> : <App />}</React.StrictMode>,
);
