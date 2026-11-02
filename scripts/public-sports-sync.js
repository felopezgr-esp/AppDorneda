(function () {
  'use strict';

  const PRIVATE_COLLECTION = 'dorneda_app_data';
  const PRIVATE_DOCUMENT = 'temporada_2026_2027';

  const PUBLIC_COLLECTION = 'dorneda_public_data';
  const PUBLIC_DOCUMENT = 'temporada_2026_2027';

  let publicUnsubscribe = null;
  let privateUnsubscribe = null;

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function isAdminFirebaseUser() {
    try {
      return !!(
        firebase.auth().currentUser &&
        firebase.auth().currentUser.uid === FIREBASE_ADMIN_UID
      );
    } catch (e) {
      return false;
    }
  }

  // Copiamos TODO el estado de la aplicación salvo Economía.
  function getPublicSportsData(sourceDb) {
    const sports = clone(sourceDb || {});
    delete sports.economia;
    return sports;
  }

  // Aplica al móvil/PC público los datos comunes sin tocar Economía.
  function applyPublicSportsData(sports) {
    if (!sports || typeof db === 'undefined') return;

    // El dispositivo administrador utiliza directamente la nube privada.
    // Así evitamos que una copia pública interfiera mientras está sincronizando.
    if (isAdminFirebaseUser()) return;

    const localEconomia = db.economia;

    Object.keys(sports).forEach(function (key) {
      if (key === 'economia') return;
      db[key] = clone(sports[key]);
    });

    // Economía nunca llega desde el documento público.
    if (localEconomia !== undefined) {
      db.economia = localEconomia;
    }

    try {
      localStorage.setItem(DB_KEY, JSON.stringify(db));
    } catch (e) {}

    try {
      if (
        typeof currentSection !== 'undefined' &&
        typeof window.renderSection === 'function'
      ) {
        window.renderSection(currentSection);
      }
    } catch (e) {}

    console.log('✓ Datos deportivos públicos sincronizados');
  }

  function startPublicListener() {
    if (publicUnsubscribe) return;

    const publicRef = firebase
      .firestore()
      .collection(PUBLIC_COLLECTION)
      .doc(PUBLIC_DOCUMENT);

    publicUnsubscribe = publicRef.onSnapshot(
      function (snapshot) {
        if (!snapshot.exists) return;

        const data = snapshot.data();

        if (data && data.sports) {
          applyPublicSportsData(data.sports);
        }
      },
      function (error) {
        console.warn('Sincronización deportiva pública:', error);
      }
    );
  }

  // El PC/dispositivo autenticado mantiene automáticamente
  // la copia pública actualizada.
  function startPrivateMirror(user) {
    if (privateUnsubscribe) {
      privateUnsubscribe();
      privateUnsubscribe = null;
    }

    if (!user || user.uid !== FIREBASE_ADMIN_UID) return;

    const privateRef = firebase
      .firestore()
      .collection(PRIVATE_COLLECTION)
      .doc(PRIVATE_DOCUMENT);

    const publicRef = firebase
      .firestore()
      .collection(PUBLIC_COLLECTION)
      .doc(PUBLIC_DOCUMENT);

    privateUnsubscribe = privateRef.onSnapshot(
      function (snapshot) {
        if (!snapshot.exists) return;

        const data = snapshot.data();

        if (!data || !data.db) return;

        const sports = getPublicSportsData(data.db);

        publicRef
          .set(
            {
              sports: sports,
              updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
              version: 'sports-public-v1'
            },
            { merge: false }
          )
          .then(function () {
            console.log('✓ Datos deportivos publicados para todos los dispositivos');
          })
          .catch(function (error) {
            console.error(
              'No se pudieron publicar los datos deportivos:',
              error
            );
          });
      },
      function (error) {
        console.warn('Espejo deportivo privado:', error);
      }
    );
  }

  function initPublicSportsSync() {
    if (typeof firebase === 'undefined' || !firebase.apps.length) {
      setTimeout(initPublicSportsSync, 300);
      return;
    }

    startPublicListener();

    firebase.auth().onAuthStateChanged(function (user) {
      startPrivateMirror(user);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      setTimeout(initPublicSportsSync, 100);
    });
  } else {
    setTimeout(initPublicSportsSync, 100);
  }
})();