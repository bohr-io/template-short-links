// The home page: fills in this site's address.
import { $, ready } from './ui.js';

ready();
$('#domain').textContent = location.host;
$('#demo-host').textContent = location.host;
